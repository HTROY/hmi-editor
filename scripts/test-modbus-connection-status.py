"""E2E regression test: modbus plugin must stop reporting "connected" after its TCP peer dies.

Starts a tiny in-process Modbus TCP slave, boots the real backend against it,
waits for the plugin to reach connected, then closes the slave side of the
socket and asserts the monitor API eventually reports a state other than
"connected" (0/1/3), i.e. the exact symptom reported for the Web UI showing
"已连接" while the device is unreachable.

Requires: io-backend/target/debug/hmi-io-backend.exe and io-backend/plugins/modbus_tcp.wasm
Run: python scripts/test-modbus-connection-status.py
"""

import json
import os
import shutil
import socket
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = Path(
    os.environ.get(
        "HMI_BACKEND",
        ROOT / "io-backend" / "target" / "debug" / "hmi-io-backend.exe",
    )
)
PLUGIN_DIR = ROOT / "io-backend" / "plugins"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FakeModbusSlave:
    """Minimal Modbus TCP slave; stop() simulates the device/server dying."""

    def __init__(self, port: int):
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._sock.bind(("127.0.0.1", port))
        self._sock.listen(8)
        self._alive = True
        self._conns: set[socket.socket] = set()
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._accept_loop, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def _accept_loop(self) -> None:
        while self._alive:
            try:
                conn, _ = self._sock.accept()
            except OSError:
                return
            with self._lock:
                self._conns.add(conn)
            threading.Thread(target=self._handle, args=(conn,), daemon=True).start()

    def _handle(self, conn: socket.socket) -> None:
        try:
            while True:
                head = conn.recv(7)
                if len(head) != 7:
                    return
                tid, pid, length, uid = struct.unpack(">HHHB", head)
                if pid != 0:
                    return
                pdu = b""
                while len(pdu) < length - 1:
                    chunk = conn.recv(length - 1 - len(pdu))
                    if not chunk:
                        return
                    pdu += chunk
                fc = pdu[0]
                if fc in (0x01, 0x02, 0x03, 0x04):
                    if len(pdu) < 5:
                        return
                    count = struct.unpack(">H", pdu[3:5])[0]
                    if fc in (0x01, 0x02):
                        data = bytes((count + 7) // 8)
                        payload = bytes([fc, len(data)]) + data
                    else:
                        regs = b"\x12\x34\x56\x78" * ((count + 1) // 2)
                        payload = bytes([fc, count * 2]) + regs[: count * 2]
                elif fc in (0x05, 0x06):
                    payload = pdu
                elif fc == 0x10:
                    payload = pdu[:5]
                else:
                    payload = bytes([fc | 0x80, 0x01])
                conn.sendall(
                    struct.pack(">HHH", tid, 0, 1 + len(payload)) + bytes([uid]) + payload
                )
        except OSError:
            pass
        finally:
            conn.close()
            with self._lock:
                self._conns.discard(conn)

    def stop(self) -> None:
        self._alive = False
        try:
            self._sock.close()
        except OSError:
            pass
        with self._lock:
            for conn in list(self._conns):
                try:
                    conn.shutdown(socket.SHUT_RDWR)
                except OSError:
                    pass
                try:
                    conn.close()
                except OSError:
                    pass
            self._conns.clear()
        self._thread.join(timeout=2)


def get_json(url: str):
    try:
        with urllib.request.urlopen(url, timeout=2) as r:
            return json.loads(r.read())
    except Exception:
        return None


def main() -> int:
    if not BACKEND.exists():
        print(f"FAIL: backend binary not found at {BACKEND} (build with scripts/build.ps1 first)")
        return 2
    if not (PLUGIN_DIR / "modbus_tcp.wasm").exists():
        print(f"FAIL: {PLUGIN_DIR / 'modbus_tcp.wasm'} not found")
        return 2

    mb_port = free_port()
    ws_port = free_port()
    web_port = free_port()
    config = f"""
server:
  host: "127.0.0.1"
  port: {ws_port}
  web_port: {web_port}
plugins:
  directory: "{PLUGIN_DIR.as_posix()}"
  scan_interval_ms: 500
  instances:
    - name: "modbus_tcp"
      wasm_file: "modbus_tcp.wasm"
      config:
        host: "127.0.0.1"
        port: {mb_port}
        slave_id: 1
      points:
        - id: "REG_0"
          address: "holding_register:0"
          data_type: "uint16"
          var_type: "AI"
        - id: "REG_1"
          address: "holding_register:2"
          data_type: "uint16"
          var_type: "AI"
"""

    slave = FakeModbusSlave(mb_port)
    slave.start()
    backend = None
    out_log = None
    err_log = None
    tmp = tempfile.mkdtemp(prefix="hmi-modbus-e2e-")
    work = Path(tmp)
    try:
        (work / "config.yaml").write_text(config, encoding="utf-8")
        out_log = open(work / "backend.log", "wb")
        err_log = open(work / "backend.err.log", "wb")
        backend = subprocess.Popen(
            [str(BACKEND), "config.yaml"],
            cwd=work,
            stdout=out_log,
            stderr=err_log,
        )
        api = f"http://127.0.0.1:{web_port}/api/monitor/overview"

        snap = None
        for _ in range(40):
            time.sleep(0.5)
            snap = get_json(api)
            if snap and snap["plugins"] and snap["plugins"][0]["connection_state"] == 2:
                break
        if not snap or not snap["plugins"] or snap["plugins"][0]["connection_state"] != 2:
            print("FAIL: backend never reported the plugin as connected")
            return 1

        slave.stop()

        final = None
        for _ in range(30):
            time.sleep(0.5)
            final = get_json(api)
            if final and final["plugins"] and final["plugins"][0]["connection_state"] != 2:
                break
        state = final["plugins"][0]["connection_state"] if final and final["plugins"] else None
        label = final["plugins"][0]["connection_label"] if final and final["plugins"] else None
        print(f"after link loss: connection_state={state} label={label}")
        if final and final["plugins"]:
            p = final["plugins"][0]
            print(
                f"  scans={p['scan_count']} errors={p['error_count']} "
                f"last_error={p['last_error']!r}"
            )
            points = get_json(f"http://127.0.0.1:{web_port}/api/monitor/plugins/modbus_tcp/points")
            if points:
                print(
                    "  points: "
                    + ", ".join(f"{pt['variable_id']}={pt['value']} q={pt['quality']}" for pt in points)
                )
            packets = get_json(
                f"http://127.0.0.1:{web_port}/api/monitor/plugins/modbus_tcp/packets?limit=8"
            )
            if packets:
                print("  packets: " + " | ".join(f"{pk['direction']} {pk['summary']}" for pk in packets[-4:]))
            log = (work / "backend.err.log").read_text(errors="replace")
            tail = log[-1200:]
            print("  backend log tail:\n" + "\n".join("    " + ln for ln in tail.splitlines()[-12:]))
        if state == 2:
            print("FAIL: plugin still reports connected after its TCP peer died")
            return 1
        print("PASS: plugin stopped reporting connected after link loss")
        return 0
    finally:
        if backend and backend.poll() is None:
            backend.kill()
            backend.wait(timeout=5)
        if out_log is not None:
            out_log.close()
        if err_log is not None:
            err_log.close()
        shutil.rmtree(tmp, ignore_errors=True)
        slave.stop()


if __name__ == "__main__":
    sys.exit(main())
