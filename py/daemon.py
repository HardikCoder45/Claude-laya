#!/usr/bin/env python3
"""Warm Laya daemon. One JSON line in, one JSON line out, over a unix socket.

Why a daemon: importing torch + loading the checkpoint takes seconds, but a warm Laya answers a
dozen typed questions in ~65 ms. The Node hook is a thin client; if this process is cold or late
the hook falls back to lexical ranking, so a prompt is never blocked.

Ops: ping | decide | shutdown
"""
import hashlib
import json
import os
import re
import socketserver
import sys
import threading
import time

import numpy as np

HOME = os.environ.get("LAYA_HOME") or os.path.expanduser("~/.laya")
SOCK = os.environ.get("LAYA_SOCK") or os.path.join(HOME, "daemon.sock")
PIDF = os.path.join(HOME, "daemon.pid")
REG = os.path.join(HOME, "registry.json")
EMBF = os.path.join(HOME, "emb.npz")
MODEL = os.environ.get("LAYA_MODEL", "english")
IDLE_S = float(os.environ.get("LAYA_IDLE_MIN", "45")) * 60
KINDS = ("skill", "agent", "mcp", "plugin")
MAX_LEN = int(os.environ.get("LAYA_MAX_LEN", "384"))
HEAD_LEN = int(os.environ.get("LAYA_HEAD_LEN", "192"))
MAX_CANDS = 9  # + "none" = 10 options: the checkpoint's temperature for 11+ options is uncalibrated

LOCK = threading.Lock()  # torch on MPS is not re-entrant: serialize forwards
S = {"warm": "loading", "device": None, "last": time.time(), "reg_mtime": 0, "items": [], "by_kind": {}}
EMB = {}  # text-hash -> float32 unit vector

DOMAINS = {
    "code": "software engineering, programming, debugging, refactoring, tests, APIs",
    "frontend_ui": "web frontend, UI/UX design, CSS, React, landing pages, dashboards",
    "data_db": "databases, SQL, analytics, data pipelines, storage",
    "devops_infra": "deployment, CI/CD, cloud, containers, infrastructure, releases",
    "security": "security review, vulnerabilities, authentication, secrets, hardening",
    "research": "researching, finding tools or papers, comparing options, reading docs",
    "writing_docs": "writing, documentation, emails, content, editing prose",
    "media_3d_video": "images, video, 3D, animation, audio, CAD, creative assets",
    "office_files": "office documents, PDFs, spreadsheets, slide decks",
    "agents_meta": "agent orchestration, plugins, skills, MCP, hooks, automation workflows",
}
FLAGS = {
    "needs_research": "Does `request` ask to research, compare or find the best options?",
    "needs_install": "Does `request` need a skill, plugin, agent or MCP connector that may not be installed yet?",
    "sensitive": "Does `request` touch production, money, credentials, deletion or other risky actions?",
}


def log(msg):
    sys.stderr.write("%s daemon: %s\n" % (time.strftime("%Y-%m-%dT%H:%M:%S"), msg))
    sys.stderr.flush()


def key(text):
    return hashlib.sha1(text.encode("utf8")).hexdigest()[:16]


def item_text(it):
    return ("%s: %s" % (it["name"].replace(":", " "), it.get("desc", "")))[:300]


def load_cache():
    try:
        z = np.load(EMBF, allow_pickle=False)
        for k, v in zip(z["keys"].tolist(), z["vecs"]):
            EMB[k] = v
        log("embedding cache: %d vectors" % len(EMB))
    except Exception:
        pass


def save_cache():
    try:
        keys = list(EMB.keys())
        tmp = EMBF + ".tmp.npz"
        np.savez_compressed(tmp, keys=np.array(keys), vecs=np.stack([EMB[k] for k in keys]) if keys else np.zeros((0, 1)))
        os.replace(tmp, EMBF)
    except Exception as e:  # cache is an optimization only
        log("cache save failed: %s" % e)


def embed(texts):
    v = EMBED_FN(texts)
    v = np.asarray(v, dtype=np.float32)
    n = np.linalg.norm(v, axis=1, keepdims=True)
    return v / np.maximum(n, 1e-9)


def refresh_index():
    """(Re)embed any registry item we have not seen. Cached by text hash, so a refresh is cheap."""
    try:
        mt = os.path.getmtime(REG)
    except OSError:
        return
    if mt == S["reg_mtime"]:
        return
    reg = json.load(open(REG))
    items = [it for it in reg["items"] if it["kind"] in KINDS]
    texts = {key(item_text(it)): item_text(it) for it in items}
    missing = [k for k in texts if k not in EMB]
    if missing:
        S["warm"] = "embedding"
        t0 = time.time()
        with LOCK:
            for i in range(0, len(missing), 32):
                chunk = missing[i:i + 32]
                vecs = embed([texts[k] for k in chunk])
                for k, v in zip(chunk, vecs):
                    EMB[k] = v
        log("embedded %d new items in %.1fs" % (len(missing), time.time() - t0))
        save_cache()
    by_kind = {}
    for it in items:
        by_kind.setdefault(it["kind"], []).append(it)
    S["by_kind"] = {
        kind: (lst, np.stack([EMB[key(item_text(it))] for it in lst])) for kind, lst in by_kind.items()
    }
    S["items"] = items
    S["reg_mtime"] = mt
    S["warm"] = "ready"


def label_for(it, used):
    base = re.sub(r"[^A-Za-z0-9 _.:/-]", "", it["name"])[:40] or "item"
    lab, n = base, 2
    while lab in used:
        lab, n = "%s#%d" % (base, n), n + 1
    used.add(lab)
    return lab


def short_desc(it):
    return " ".join((it.get("desc") or "").split()[:14])


def decide(req):
    t0 = time.time()
    refresh_index()
    if S["warm"] != "ready":
        return {"ok": True, "ready": False, "warm": S["warm"]}
    prompt = (req.get("prompt") or "")[:1500]
    lex = req.get("lex") or {}
    banned = set(req.get("exclude") or [])
    with LOCK:
        qv = embed([prompt[:1200]])[0]
    questions = {
        "domain": {"type": "choice", "instructions": "What kind of work is `request`?", "criteria": DOMAINS},
        "difficulty": {"type": "score", "instructions": "How hard is `request` for an AI coding agent?",
                       "criteria": ["trivial", "easy", "moderate", "hard multi-step"]},
    }
    for name, q in FLAGS.items():
        questions[name] = {"type": "noul", "instructions": q}

    maps, embs = {}, {}
    for kind in KINDS:
        if kind not in S["by_kind"]:
            continue
        lst, mat = S["by_kind"][kind]
        sims = mat @ qv
        order = [i for i in np.argsort(-sims) if lst[i]["id"] not in banned]
        idx_by_id = {it["id"]: i for i, it in enumerate(lst)}
        picked, seen = [], set()
        e_top = [lst[i]["id"] for i in order[:8]]
        l_top = [x for x in (lex.get(kind) or [])[:6] if x in idx_by_id and x not in banned]
        for cid in [v for pair in zip(e_top, l_top + [None] * 8) for v in pair if v] + e_top + l_top:
            if cid not in seen and len(picked) < MAX_CANDS:
                seen.add(cid)
                picked.append(cid)
        used, labels = set(), {}
        crit = {}
        for cid in picked:
            it = lst[idx_by_id[cid]]
            lab = label_for(it, used)
            labels[lab] = cid
            crit[lab] = short_desc(it) or it["name"]
            embs[cid] = float(sims[idx_by_id[cid]])
        crit["none"] = "none of these is a good fit for the request"
        maps[kind] = labels
        questions["pick_" + kind] = {
            "type": "choice",
            "instructions": "Which %s would best help with `request`?" % kind, "criteria": crit,
        }
    with LOCK:
        res = ROUTER.predict({"request": prompt}, questions, model=MODEL, max_len=MAX_LEN, head_max_len=HEAD_LEN)
    ans = res["answers"]
    out = {
        "ok": True, "ready": True, "device": S["device"],
        "features": {
            "domain": {"choice": ans["domain"]["choice"], "p": ans["domain"]["probabilities"].get(ans["domain"]["choice"], 0)},
            "difficulty": {"score": ans["difficulty"]["score"]},
            "flags": {n: ans[n]["noul"] for n in FLAGS},
        },
        "kinds": {},
    }
    for kind, labels in maps.items():
        probs = ans["pick_" + kind]["probabilities"]
        out["kinds"][kind] = {
            "none_p": probs.get("none", 0.0),
            "cands": [{"id": cid, "p": probs.get(lab, 0.0), "emb": embs[cid]} for lab, cid in labels.items()],
        }
    out["ms"] = int((time.time() - t0) * 1000)
    return out


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        S["last"] = time.time()
        try:
            req = json.loads(self.rfile.readline())
            op = req.get("op")
            if op == "ping":
                resp = {"ok": True, "warm": S["warm"], "device": S["device"], "items": len(S["items"]), "pid": os.getpid()}
            elif op == "decide":
                resp = decide(req)
            elif op == "shutdown":
                resp = {"ok": True}
                threading.Thread(target=lambda: (time.sleep(0.1), os._exit(0))).start()
            else:
                resp = {"ok": False, "error": "unknown op"}
        except Exception as e:  # never crash the server on one bad request
            log("request error: %r" % (e,))
            resp = {"ok": False, "error": str(e)[:200]}
        self.wfile.write((json.dumps(resp) + "\n").encode("utf8"))


def alive():
    import socket
    s = socket.socket(socket.AF_UNIX)
    s.settimeout(0.5)
    try:
        s.connect(SOCK)
        return True
    except OSError:
        return False
    finally:
        s.close()


def idle_watch():
    while True:
        time.sleep(60)
        if time.time() - S["last"] > IDLE_S:
            log("idle for %.0f min: exiting (it restarts on the next session)" % (IDLE_S / 60))
            cleanup()
            os._exit(0)


def cleanup():
    for f in (SOCK, PIDF):
        try:
            os.unlink(f)
        except OSError:
            pass


def warm_thread():
    global ROUTER, EMBED_FN
    try:
        from laya import Router
        from laya.shortlist import embed_fn_from_agent
        t0 = time.time()
        ROUTER = Router(preload=False)
        agent = ROUTER.load(MODEL)
        EMBED_FN = embed_fn_from_agent(agent, max_length=96, batch_size=32)
        S["device"] = str(getattr(agent, "device", "cpu"))
        log("laya loaded on %s in %.1fs" % (S["device"], time.time() - t0))
        load_cache()
        refresh_index()
        # prime kernels so the first real prompt is not the slow one
        with LOCK:
            ROUTER.predict({"request": "warm up"}, {"d": {"type": "noul", "instructions": "Is `request` a test?"}}, model=MODEL)
        S["warm"] = "ready"
    except Exception as e:
        S["warm"] = "failed"
        log("warm failed: %r" % (e,))


def main():
    if alive():
        log("another daemon is already serving %s" % SOCK)
        return
    try:
        os.unlink(SOCK)
    except OSError:
        pass
    os.makedirs(HOME, exist_ok=True)
    open(PIDF, "w").write(str(os.getpid()))
    srv = socketserver.ThreadingUnixStreamServer(SOCK, Handler)
    os.chmod(SOCK, 0o600)  # only this user
    threading.Thread(target=warm_thread, daemon=True).start()
    threading.Thread(target=idle_watch, daemon=True).start()
    log("listening on %s (pid %d)" % (SOCK, os.getpid()))
    try:
        srv.serve_forever()
    finally:
        cleanup()


if __name__ == "__main__":
    main()
