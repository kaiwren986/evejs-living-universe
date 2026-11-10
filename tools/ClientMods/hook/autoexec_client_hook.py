# EveJS client mod hook (Python 2.7, runs inside the EVE client).
#
# tools/ClientMods/patchClient.js puts this in code.ccp in place of
# autoexec_client and keeps the original module as
# evejs_original_autoexec_client. Importing that runs the client's normal
# startup unchanged; only then is client-mods/loader.py read from disk.
#
# Rebuild the compiled copy with: python tools/ClientMods/buildHook.py
import evejs_original_autoexec_client

EVEJS_HOOK_VERSION = 1


def _evejs_mods_root():
    import os
    root = os.environ.get('EVEJS_CLIENT_MODS')
    if root:
        return root
    try:
        import blue
        tq = blue.paths.ResolvePath(u'root:/')
        return os.path.normpath(os.path.join(tq, '..', '..', '..', 'client-mods'))
    except Exception:
        return None


def _evejs_boot():
    import os, sys
    root = _evejs_mods_root()
    if not root:
        return
    path = os.path.join(root, 'loader.py')
    if not os.path.isfile(path):
        return
    module = type(sys)('evejs_loader')
    module.__file__ = path
    sys.modules['evejs_loader'] = module
    source = open(path, 'rb').read().replace('\r\n', '\n')
    exec compile(source, path, 'exec') in module.__dict__
    module.boot(root, EVEJS_HOOK_VERSION)


try:
    _evejs_boot()
except Exception:
    try:
        import os, traceback
        log = open(os.path.join(_evejs_mods_root() or '.', 'hook-crash.log'), 'a')
        try:
            traceback.print_exc(file=log)
        finally:
            log.close()
    except Exception:
        pass
