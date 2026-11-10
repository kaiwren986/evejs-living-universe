# -*- coding: utf-8 -*-
"""EveJS client mod loader (Python 2.7, runs inside the EVE client).

The code.ccp hook (tools/ClientMods) runs this file at client startup. Once the
game's services are up it loads every mods/*.py, and it reloads a mod whenever
its file changes, so client UI can be edited without restarting EVE.

A mod is a plain module. Optional functions:
    load(api)   called after the module runs, and again after every reload
    unload()    called before a reload, or when the file is deleted

Names starting with "_" are skipped. Output goes to _logs/client.log.
"""
import os
import sys
import time
import traceback

import blue

POLL_MS = 1500
LOG_LIMIT_BYTES = 1024 * 1024

ROOT = None
LOG_PATH = None
HOOK_VERSION = None
LOADED = {}  # mod name -> {'module', 'mtime', 'path'}
# Unloaded modules are kept referenced: Python 2 sets a collected module's globals
# to None, which would crash any tasklet of the old copy before it sees its stop flag.
RETIRED = []


def log(message):
    line = '%s %s\n' % (time.strftime('%H:%M:%S'), message)
    try:
        handle = open(LOG_PATH, 'a')
        try:
            handle.write(line.encode('utf-8') if isinstance(line, unicode) else line)
        finally:
            handle.close()
    except Exception:
        pass


def log_exception(context):
    log('%s\n%s' % (context, traceback.format_exc()))


def sleep(ms):
    blue.pyos.synchro.SleepWallclock(ms)


def spawn(func, *args):
    """Run func in its own tasklet; exceptions are logged instead of lost."""
    def guarded():
        try:
            func(*args)
        except Exception:
            log_exception('tasklet %s failed' % getattr(func, '__name__', func))
    return blue.pyos.CreateTasklet(guarded, (), {})


class Api(object):
    """What a mod receives in load(api)."""

    def __init__(self, name):
        self.name = name
        self.root = ROOT

    def log(self, message):
        log('[%s] %s' % (self.name, message))

    def log_exception(self, context):
        log_exception('[%s] %s' % (self.name, context))

    def spawn(self, func, *args):
        return spawn(func, *args)

    def sleep(self, ms):
        sleep(ms)

    def server(self):
        """The EveJS server bridge (server/src/services/evejsMod)."""
        return sm.RemoteSvc('evejsMod')

    def call(self, method, *args):
        return getattr(self.server(), method)(*args)

    def notify(self, text):
        """A small toast message, like the game's own notices."""
        try:
            from player_messaging.client.ui_message import prompt_player_fsd_dialog
            prompt_player_fsd_dialog('CustomNotify', {'notify': text})
        except Exception:
            log_exception('notify failed')


def boot(root, hook_version):
    global ROOT, LOG_PATH, HOOK_VERSION
    ROOT = root
    HOOK_VERSION = hook_version
    logs = os.path.join(root, '_logs')
    if not os.path.isdir(logs):
        os.makedirs(logs)
    LOG_PATH = os.path.join(logs, 'client.log')
    try:
        if os.path.getsize(LOG_PATH) > LOG_LIMIT_BYTES:
            old = LOG_PATH + '.old'
            if os.path.exists(old):
                os.remove(old)
            os.rename(LOG_PATH, old)
    except OSError:
        pass
    log('=== EveJS client mods: loader started (hook v%s, root %s)' % (hook_version, root))
    spawn(_run)


def _run():
    import __builtin__
    while getattr(__builtin__, 'sm', None) is None:
        sleep(250)
    while not sm.IsServiceRunning('gameui'):
        sleep(250)
    log('game services are up; loading mods')
    while True:
        try:
            _scan()
        except Exception:
            log_exception('mod scan failed')
        sleep(POLL_MS)


def _mod_files():
    folder = os.path.join(ROOT, 'mods')
    found = {}
    if os.path.isdir(folder):
        for filename in sorted(os.listdir(folder)):
            if filename.endswith('.py') and not filename.startswith('_'):
                path = os.path.join(folder, filename)
                found[filename[:-3]] = (path, os.path.getmtime(path))
    return found


def _scan():
    found = _mod_files()
    for name in sorted(set(LOADED) - set(found)):
        _unload(name)
        log('mod removed: %s' % name)
    for name in sorted(found):
        path, mtime = found[name]
        current = LOADED.get(name)
        if current is None or current['mtime'] != mtime:
            if current is not None:
                _unload(name)
            _load(name, path, mtime)


def _load(name, path, mtime):
    module = type(sys)('evejs_mods.' + name)
    module.__file__ = path
    LOADED[name] = {'module': module, 'mtime': mtime, 'path': path}
    try:
        source = open(path, 'rb').read().replace('\r\n', '\n')
        exec compile(source, path, 'exec') in module.__dict__
        sys.modules[module.__name__] = module
        if hasattr(module, 'load'):
            module.load(Api(name))
        log('mod loaded: %s' % name)
    except Exception:
        log_exception('mod failed to load: %s' % name)


def _unload(name):
    entry = LOADED.pop(name, None)
    if entry is None:
        return
    module = entry['module']
    try:
        if hasattr(module, 'unload'):
            module.unload()
    except Exception:
        log_exception('mod failed to unload: %s' % name)
    sys.modules.pop(module.__name__, None)
    RETIRED.append(module)
    del RETIRED[:-20]
