"""Syntax-check every client mod with the EVE client's own Python 2.7.

Developer tool: catches syntax errors before the game does.

    python tools/ClientMods/checkMods.py [path\\to\\client\\EVE\\tq]

The 2.7 interpreter runs in a child process so a crash in it cannot take this one down.
"""
import ctypes
import os
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
MODS = REPO / "client-mods"


def check_in_child(dll, *files):
    os.add_dll_directory(str(Path(dll).parent))
    py = ctypes.CDLL(str(dll))
    for flag in ("Py_NoSiteFlag", "Py_IgnoreEnvironmentFlag", "Py_FrozenFlag", "Py_DontWriteBytecodeFlag"):
        ctypes.c_int.in_dll(py, flag).value = 1
    py.Py_InitializeEx(0)
    script = (
        "import sys\n"
        "failed = 0\n"
        "for path in %r:\n"
        "    try:\n"
        "        compile(open(path, 'rb').read().replace(chr(13) + chr(10), chr(10)), path, 'exec')\n"
        "        sys.stdout.write('ok    ' + path + chr(10))\n"
        "    except SyntaxError as error:\n"
        "        failed += 1\n"
        "        sys.stdout.write('ERROR %%s line %%s: %%s' %% (path, error.lineno, error.msg) + chr(10))\n"
        "sys.stdout.flush()\n"
        "if failed: raise SystemExit(1)\n"
    ) % (list(files),)
    sys.exit(1 if py.PyRun_SimpleString(script.encode("utf-8")) else 0)


def main():
    if len(sys.argv) >= 2 and sys.argv[1] == "--child":
        check_in_child(*sys.argv[2:])
    tq = Path(sys.argv[1]) if len(sys.argv) > 1 else REPO / "client" / "EVE" / "tq"
    dll = tq / "bin64" / "python27.dll"
    if not dll.is_file():
        sys.exit(f"python27.dll not found at {dll}")
    files = sorted(str(path) for path in MODS.rglob("*.py"))
    result = subprocess.run([sys.executable, "-I", __file__, "--child", str(dll), *files])
    sys.exit(result.returncode)


if __name__ == "__main__":
    main()
