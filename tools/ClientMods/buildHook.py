"""Compile the client mod hook to Python 2.7 bytecode with the EVE client's own python27.dll.

Developer tool: run it after editing hook/autoexec_client_hook.py, then commit the
.bin it writes. The launcher only needs Node (patchClient.js), never Python.

    python tools/ClientMods/buildHook.py [path\\to\\client\\EVE\\tq]

The 2.7 interpreter runs in a child process so a crash in it cannot take this one down.
"""
import ctypes
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
SOURCE = HERE / "hook" / "autoexec_client_hook.py"
# A full .pyc image (magic, mtime, code). Not named .pyc: the repo ignores *.pyc.
OUTPUT = HERE / "hook" / "autoexec_client_hook.bin"
PY27_MAGIC = bytes.fromhex("03f30d0a")


def compile_in_child(dll, source, marshal_out):
    os.add_dll_directory(str(Path(dll).parent))
    py = ctypes.CDLL(str(dll))
    for flag in ("Py_NoSiteFlag", "Py_IgnoreEnvironmentFlag", "Py_FrozenFlag", "Py_DontWriteBytecodeFlag"):
        ctypes.c_int.in_dll(py, flag).value = 1
    py.Py_InitializeEx(0)
    script = (
        "import marshal\n"
        "src = open(%r, 'rb').read().replace(chr(13) + chr(10), chr(10))\n"
        "co = compile(src, 'autoexec_client.py', 'exec')\n"
        "open(%r, 'wb').write(marshal.dumps(co))\n"
    ) % (str(source), str(marshal_out))
    sys.exit(py.PyRun_SimpleString(script.encode("utf-8")))


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--child":
        compile_in_child(*sys.argv[2:5])
    tq = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "client" / "EVE" / "tq"
    dll = tq / "bin64" / "python27.dll"
    if not dll.is_file():
        sys.exit(f"python27.dll not found at {dll}")
    marshal_tmp = OUTPUT.with_suffix(".marshal.tmp")
    result = subprocess.run([sys.executable, "-I", __file__, "--child", str(dll), str(SOURCE), str(marshal_tmp)])
    if result.returncode != 0 or not marshal_tmp.is_file():
        sys.exit(f"Python 2.7 compile failed (exit {result.returncode})")
    code = marshal_tmp.read_bytes()
    marshal_tmp.unlink()
    OUTPUT.write_bytes(PY27_MAGIC + struct.pack("<I", int(time.time())) + code)
    print(f"wrote {OUTPUT.relative_to(REPO)} ({OUTPUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
