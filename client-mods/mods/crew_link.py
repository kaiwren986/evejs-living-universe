# -*- coding: utf-8 -*-
"""Crew Link: the first native EveJS window.

Shows your pilot, ship and crew from the server, and lets you talk to your crew
chief with one click. Answers come from the local AI when it is running, and from
written lines when it is not. It opens once per pilot after login; saving this
file reloads it in game.
"""
from carbonui import uiconst
from carbonui.control.button import Button
from carbonui.control.window import Window
from carbonui.primitives.container import Container
from eve.client.script.ui.control.eveLabel import EveLabelLarge, EveLabelMedium, EveLabelMediumBold, EveLabelSmall

API = None
STATE = {'alive': False, 'opened_for': set()}

QUESTIONS = (
    ('report', 'Status report'),
    ('mood', 'How is the crew?'),
    ('next', 'What next?'),
)


class CrewLinkWindow(Window):
    default_windowID = 'evejsCrewLink'
    default_caption = 'Crew Link'
    default_width = 440
    default_height = 400
    default_minSize = (360, 320)

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        footer = Container(parent=self.content, align=uiconst.TOBOTTOM, height=28, padTop=6)
        Button(parent=footer, align=uiconst.CENTERLEFT, label='Refresh', func=self.OnRefresh)
        Button(parent=footer, align=uiconst.CENTERLEFT, left=110, label='Ping server', func=self.OnPing)
        self.footnote = EveLabelSmall(parent=self.content, align=uiconst.TOBOTTOM, padTop=4, text='')

        asks = Container(parent=self.content, align=uiconst.TOBOTTOM, height=28, padTop=8)
        for index, (topic, label) in enumerate(QUESTIONS):
            Button(parent=asks, align=uiconst.CENTERLEFT, left=index * 135, label=label,
                   func=self.OnAsk, args=(topic,))

        self.header = EveLabelLarge(parent=self.content, align=uiconst.TOTOP, text='Contacting the server...')
        self.details = EveLabelMedium(parent=self.content, align=uiconst.TOTOP, padTop=4, text='')
        self.crew = EveLabelMedium(parent=self.content, align=uiconst.TOTOP, padTop=8, text='')
        self.speaker = EveLabelMediumBold(parent=self.content, align=uiconst.TOTOP, padTop=12, text='')
        self.speech = EveLabelMedium(parent=self.content, align=uiconst.TOTOP, padTop=2, text='')
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
        self.footnote.text = 'Server %s, bridge v%s' % (status.get('serverVersion'), status.get('bridgeVersion'))
        API.log('status shown for %s' % status.get('characterName'))

    def OnAsk(self, topic, *args):
        API.spawn(self._Ask, topic)

    def _Ask(self, topic):
        self.speaker.text = ''
        self.speech.text = '<color=0x88ffffff>...</color>'
        answer = API.call('AskCrew', topic)
        self.speaker.text = '%s, %s' % (answer.get('speaker'), answer.get('role'))
        self.speech.text = answer.get('text') or ''
        API.log('crew answered %s via %s' % (topic, answer.get('source')))

    def OnRefresh(self, *args):
        API.spawn(self.Refresh)

    def OnPing(self, *args):
        API.spawn(self._Ping)

    def _Ping(self):
        import blue
        started = blue.os.GetWallclockTime()
        answer = API.call('Ping', u'Hello from the Crew Link window')
        elapsed_ms = (blue.os.GetWallclockTime() - started) / 10000
        self.footnote.text = '%s  (%d ms)' % (answer, elapsed_ms)
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
