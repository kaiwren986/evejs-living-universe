# -*- coding: utf-8 -*-
"""Crew Link: the first native EveJS window.

Proves the whole chain: the code.ccp hook loads this file, the window is built
with the client's own UI toolkit, and it talks to the server's evejsMod service
over the normal game connection. It opens once per pilot after login; saving
this file reloads it in game.
"""
from carbonui import uiconst
from carbonui.control.button import Button
from carbonui.control.window import Window
from carbonui.primitives.container import Container
from eve.client.script.ui.control.eveLabel import EveLabelLarge, EveLabelMedium

API = None
STATE = {'alive': False, 'opened_for': set()}


class CrewLinkWindow(Window):
    default_windowID = 'evejsCrewLink'
    default_caption = 'Crew Link'
    default_width = 400
    default_height = 300
    default_minSize = (320, 220)

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        buttons = Container(parent=self.content, align=uiconst.TOBOTTOM, height=32, padTop=8)
        Button(parent=buttons, align=uiconst.CENTERLEFT, label='Refresh', func=self.OnRefresh)
        Button(parent=buttons, align=uiconst.CENTERLEFT, left=110, label='Ping server', func=self.OnPing)
        self.header = EveLabelLarge(parent=self.content, align=uiconst.TOTOP, text='Contacting the server...')
        self.details = EveLabelMedium(parent=self.content, align=uiconst.TOTOP, padTop=6, text='')
        self.crew = EveLabelMedium(parent=self.content, align=uiconst.TOTOP, padTop=10, text='')
        self.reply = EveLabelMedium(parent=self.content, align=uiconst.TOTOP, padTop=10, text='')
        API.spawn(self.Refresh)

    def Refresh(self):
        status = API.call('GetStatus')
        ship = status.get('shipName') or status.get('shipTypeName') or 'no ship'
        if status.get('shipTypeName') and status.get('shipName') != status.get('shipTypeName'):
            ship = '%s (%s)' % (ship, status.get('shipTypeName'))
        where = 'docked in' if status.get('docked') else 'in space,'
        self.header.text = status.get('characterName') or 'Unknown pilot'
        self.details.text = 'Flying %s, %s %s' % (ship, where, status.get('solarSystemName') or 'an unknown system')
        self.crew.text = '<br>'.join(status.get('crew') or [])
        self.reply.text = 'Server %s, bridge v%s' % (status.get('serverVersion'), status.get('bridgeVersion'))
        API.log('status shown for %s' % status.get('characterName'))

    def OnRefresh(self, *args):
        API.spawn(self.Refresh)

    def OnPing(self, *args):
        API.spawn(self._Ping)

    def _Ping(self):
        import blue
        started = blue.os.GetWallclockTime()
        answer = API.call('Ping', u'Hello from the Crew Link window')
        elapsed_ms = (blue.os.GetWallclockTime() - started) / 10000
        self.reply.text = '%s  (%d ms)' % (answer, elapsed_ms)
        API.log('ping answered in %d ms' % elapsed_ms)


def _in_game():
    return bool(session.charid and session.shipid and (session.stationid or session.structureid or session.solarsystemid))


def _watch():
    # Open once per pilot, a few seconds after they arrive in game.
    while STATE['alive']:
        charid = session.charid
        if _in_game() and charid not in STATE['opened_for']:
            API.sleep(3000)
            if STATE['alive'] and _in_game() and session.charid == charid:
                STATE['opened_for'].add(charid)
                CrewLinkWindow.Open()
                API.log('window opened for character %s' % charid)
        API.sleep(1000)


def load(api):
    global API
    API = api
    STATE['alive'] = True
    if _in_game():
        CrewLinkWindow.Open()
        STATE['opened_for'].add(session.charid)
    api.spawn(_watch)


def unload():
    STATE['alive'] = False
    CrewLinkWindow.CloseIfOpen()
