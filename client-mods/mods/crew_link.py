# -*- coding: utf-8 -*-
"""Crew Link: your ship's crew in a native EVE (Photon UI) window.

Pilot card, crew roster and a comms panel where the crew chief answers in
character (local AI when it is running, written lines when not). Everything
comes from the server's evejsMod service. Saving this file reloads it in game.

Note: names on the window object are prefixed with _cl so they never collide
with carbonui.Window's own attributes (it has header, content, sr, ...).
"""
import eveicon
from carbonui import uiconst, TextColor, ButtonVariant, Density
from carbonui.button.group import ButtonGroup, ButtonSizeMode
from carbonui.control.button import Button
from carbonui.control.buttonIcon import ButtonIcon
from carbonui.control.window import Window
from carbonui.decorative.panelUnderlay import PanelUnderlay
from carbonui.primitives.container import Container
from carbonui.primitives.containerAutoSize import ContainerAutoSize
from carbonui.primitives.fill import Fill
from carbonui.primitives.frame import Frame
from carbonui.primitives.line import Line
from carbonui.primitives.sprite import Sprite
from carbonui.text.styles import TextHeader, TextBody, TextDetail
from carbonui.uianimations import animations
from eve.client.script.ui import eveColor, eveThemeColor

API = None
STATE = {'alive': False, 'opened_for': set()}

QUESTIONS = (
    ('report', 'Status', eveicon.chat_bubble),
    ('mood', 'Morale', eveicon.people),
    ('next', 'Orders', eveicon.start_conversation),
)
CUT_FRAME = 'res:/UI/Texture/classes/Button/frame_cut_bottom_right.png'
TYPE_STEP_MS = 18


def _accent(alpha=1.0):
    r, g, b = eveThemeColor.THEME_ACCENT.rgb
    return (r, g, b, alpha)


def _security_color(security):
    if security is None:
        return TextColor.SECONDARY
    if security >= 0.45:
        return eveColor.LEAFY_GREEN
    if security > 0.0:
        return eveColor.WARNING_ORANGE
    return eveColor.DANGER_RED


def _hex(color):
    r, g, b = color[0], color[1], color[2]
    return '0xff%02x%02x%02x' % (int(r * 255), int(g * 255), int(b * 255))


class CrewLinkWindow(Window):
    default_windowID = 'evejsCrewLink'
    default_caption = 'Crew Link'
    default_iconNum = eveicon.people
    default_width = 420
    default_height = 600
    default_minSize = (360, 460)
    default_isStackable = False

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._clTyping = 0
        self._BuildFooter()
        self._BuildActions()
        self._BuildPilotCard()
        self._BuildSection('CREW', '_clCrewMeta')
        self._clRoster = ContainerAutoSize(parent=self.content, align=uiconst.TOTOP, alignMode=uiconst.TOTOP)
        self._BuildSection('COMMS', '_clCommsMeta')
        self._BuildComms()
        API.spawn(self.Refresh)

    # ----------------------------------------------------------------- layout
    def _BuildPilotCard(self):
        card = Container(parent=self.content, align=uiconst.TOTOP, height=76)
        PanelUnderlay(bgParent=card)
        Fill(parent=card, align=uiconst.TOLEFT, width=2, color=_accent(0.9))
        portrait = Container(parent=card, align=uiconst.TOLEFT, width=64, left=8, padTop=6, padBottom=6)
        Frame(bgParent=portrait, color=_accent(0.5))
        self._clPortrait = Sprite(parent=portrait, align=uiconst.TOALL, padding=1)
        ButtonIcon(parent=card, align=uiconst.TOPRIGHT, width=24, height=24, top=4, left=4, iconSize=16,
                   texturePath=eveicon.refresh, func=self.OnRefresh, hint='Refresh')
        text = ContainerAutoSize(parent=card, align=uiconst.CENTERLEFT, alignMode=uiconst.TOTOP,
                                 left=84, width=280)
        self._clPilot = TextHeader(parent=text, align=uiconst.TOTOP, text='Establishing link...', bold=True)
        self._clShip = TextBody(parent=text, align=uiconst.TOTOP, color=TextColor.SECONDARY, text='')
        self._clPlace = TextDetail(parent=text, align=uiconst.TOTOP, color=TextColor.SECONDARY, text='')

    def _BuildSection(self, title, metaAttr):
        row = Container(parent=self.content, align=uiconst.TOTOP, height=20, padTop=14)
        TextDetail(parent=row, align=uiconst.CENTERLEFT, text=title, uppercase=True, bold=True, color=_accent(1.0))
        setattr(self, metaAttr, TextDetail(parent=row, align=uiconst.CENTERRIGHT, text='', color=TextColor.SECONDARY))
        Line(parent=self.content, align=uiconst.TOTOP, weight=1, color=_accent(0.35), padTop=3, padBottom=6)

    def _BuildComms(self):
        panel = ContainerAutoSize(parent=self.content, align=uiconst.TOTOP, alignMode=uiconst.TOTOP, minHeight=96)
        Frame(bgParent=panel, texturePath=CUT_FRAME, cornerSize=9, color=_accent(0.35))
        Fill(bgParent=panel, color=(0.0, 0.0, 0.0, 0.25))
        top = Container(parent=panel, align=uiconst.TOTOP, height=20, padding=(12, 10, 12, 0))
        self._clSignal = Sprite(parent=top, align=uiconst.CENTERLEFT, width=16, height=16,
                                texturePath=eveicon.signal_strength, color=_accent(1.0),
                                outputMode=uiconst.OUTPUT_COLOR_AND_GLOW, glowBrightness=0.4)
        self._clSpeaker = TextDetail(parent=top, align=uiconst.CENTERLEFT, left=24, uppercase=True, bold=True,
                                     color=TextColor.HIGHLIGHT, text='Channel open')
        self._clSpeech = TextBody(parent=panel, align=uiconst.TOTOP, padding=(12, 6, 12, 14),
                                  color=TextColor.NORMAL, text='Choose a question below to hail your crew.')

    def _BuildActions(self):
        group = ButtonGroup(parent=self.content, align=uiconst.TOBOTTOM, density=Density.COMPACT,
                            button_size_mode=ButtonSizeMode.STRETCH, padTop=10)
        self._clButtons = []
        for index, (topic, label, icon) in enumerate(QUESTIONS):
            self._clButtons.append(Button(parent=group, label=label, texturePath=icon, func=self.OnAsk, args=(topic,),
                                          variant=ButtonVariant.PRIMARY if index == 0 else ButtonVariant.NORMAL))

    def _BuildFooter(self):
        self._clStatus = TextDetail(parent=self.content, align=uiconst.TOBOTTOM, padTop=6,
                                    color=TextColor.DISABLED, text='')

    # ------------------------------------------------------------------- data
    def Refresh(self):
        status = API.call('GetStatus')
        try:
            sm.GetService('photo').GetPortrait(session.charid, 64, self._clPortrait)
        except Exception:
            API.log_exception('portrait')
        ship = status.get('shipName') or status.get('shipTypeName') or 'No ship'
        hull = status.get('shipTypeName')
        self._clPilot.text = status.get('characterName') or 'Unknown pilot'
        self._clShip.text = ship if not hull or hull == ship else '%s  <color=0x66ffffff>%s</color>' % (ship, hull)
        security = status.get('security')
        place = status.get('solarSystemName') or 'Unknown system'
        if security is not None:
            place = '<color=%s>%.1f</color>  %s' % (_hex(_security_color(security)), security, place)
        self._clPlace.text = '%s  -  %s' % (place, 'Docked' if status.get('docked') else 'In space')
        self._LoadRoster(status.get('crewInfo') or {}, status.get('crew') or [])
        self._clStatus.text = 'SERVER %s  -  BRIDGE v%s' % (status.get('serverVersion'), status.get('bridgeVersion'))

    def _LoadRoster(self, info, legacyLines):
        self._clRoster.Flush()
        if not info.get('available'):
            note = info.get('note') or (legacyLines[0] if legacyLines else 'No crew data.')
            TextBody(parent=self._clRoster, align=uiconst.TOTOP, color=TextColor.SECONDARY, text=note, padBottom=4)
            self._clCrewMeta.text = ''
            return
        self._clCrewMeta.text = '%s  -  %s' % (info.get('job') or 'Standing by', info.get('station') or '')
        for index, person in enumerate(info.get('roster') or []):
            row = Container(parent=self._clRoster, align=uiconst.TOTOP, height=40, padBottom=4)
            PanelUnderlay(bgParent=row)
            Fill(parent=row, align=uiconst.TOLEFT, width=2, color=_accent(0.6 if index else 0.95))
            Sprite(parent=row, align=uiconst.CENTERLEFT, left=12, width=16, height=16,
                   texturePath=eveicon.person, color=(1.0, 1.0, 1.0, 0.5))
            TextBody(parent=row, align=uiconst.CENTERLEFT, left=38, top=-7, text=person.get('name') or 'Crew member')
            TextDetail(parent=row, align=uiconst.CENTERLEFT, left=38, top=9, color=TextColor.SECONDARY,
                       text=(person.get('role') or 'Crew') + ('  -  Crew chief' if index == 0 else ''))
            row.opacity = 0.0
            animations.FadeTo(row, 0.0, 1.0, duration=0.35, timeOffset=index * 0.08)
            animations.MoveInFromLeft(row, amount=12, duration=0.35, timeOffset=index * 0.08)

    # ---------------------------------------------------------------- actions
    def OnAsk(self, topic, *args):
        API.spawn(self._Ask, topic)

    def _Ask(self, topic):
        for button in self._clButtons:
            button.busy = True
        self._clTyping += 1
        self._clSpeaker.text = 'Hailing crew...'
        self._clSpeech.text = ''
        animations.MorphScalar(self._clSignal, 'glowBrightness', 0.2, 1.2, duration=0.6,
                               loops=uiconst.ANIM_REPEAT, curveType=uiconst.ANIM_WAVE)
        try:
            answer = API.call('AskCrew', topic)
        finally:
            animations.StopAllAnimations(self._clSignal)
            self._clSignal.glowBrightness = 0.4
            for button in self._clButtons:
                button.busy = False
        self._clSpeaker.text = '%s  -  %s' % (answer.get('speaker'), answer.get('role'))
        voiced = answer.get('source') == 'ai'
        self._clCommsMeta.text = 'AI voice' if voiced else 'Written line'
        self._Typewrite(answer.get('text') or '')
        API.log('crew answered %s via %s' % (topic, answer.get('source')))

    def _Typewrite(self, text):
        ticket = self._clTyping
        for end in range(2, len(text) + 2, 2):
            if ticket != self._clTyping or self.destroyed:
                return
            self._clSpeech.text = text[:end] + ('' if end >= len(text) else '<color=0x88ffffff>_</color>')
            API.sleep(TYPE_STEP_MS)

    def OnRefresh(self, *args):
        API.spawn(self.Refresh)


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
        CrewLinkWindow.CloseIfOpen()
        CrewLinkWindow.Open()
        STATE['opened_for'].add(session.charid)
    api.spawn(_watch)


def unload():
    STATE['alive'] = False
    CrewLinkWindow.CloseIfOpen()
