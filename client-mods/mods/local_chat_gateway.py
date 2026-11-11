# -*- coding: utf-8 -*-
"""Local chat over the game's own chat gateway instead of XMPP.

Why this exists: the client has two ways to run the Local channel. The older
one (XMPP) only knows about characters with a live chat connection. The newer
one (the "local chat service", a list the server pushes) is switched by a
feature flag that is off by default. Living Universe pilots have no chat
connection, so they can only ever appear through the newer one. The server
also sends the flag, but a flag that arrives late or not at all would silently
leave Local on XMPP and empty of pilots, so this mod makes sure of it.

It calls the chat service's own handler for that flag, the same one the flag
system calls, so the client does the switch (close the XMPP Local window, open
the gateway one) the way it was built to. Removing this file leaves the choice
to the flag again.
"""

API = None
STATE = {'token': None}
POLL_MS = 3000


def _ensure():
    if not getattr(session, 'charid', None):
        return
    chat = sm.GetService('chat')
    if chat.is_local_chat_service_enabled is True:
        return
    chat._on_local_chat_service_flag_changed(lambda: True)
    API.log('Local switched to the chat gateway')


def _run(token):
    failures = 0
    while STATE['token'] is token:
        try:
            _ensure()
            failures = 0
        except Exception:
            failures += 1
            if failures <= 3:
                API.log_exception('could not switch Local to the chat gateway')
        API.sleep(POLL_MS * (10 if failures >= 5 else 1))


def load(api):
    global API
    API = api
    token = object()
    STATE['token'] = token
    api.spawn(_run, token)


def unload():
    STATE['token'] = None
