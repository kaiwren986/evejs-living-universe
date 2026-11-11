# -*- coding: utf-8 -*-
"""Crew Link: your ship's crew and contracts in a native EVE (Photon UI) window.

Two tabs under a pilot card:
  Crew       roster and a comms panel where the crew chief (or Aura) answers.
  Contracts  generated story contracts: request one, read the briefing, accept
             it (a real combat site and a saved location are created), kill the
             leader, get paid and debriefed.
  Contacts   clients you have completed work for: their trust in you, what it
             pays, and buttons to hail them or ask them for work.

Everything comes from the server's evejsMod service; the local AI writes the
words, the server decides the facts. Saving this file reloads it in game.

Note: names on the window object are prefixed with _cl so they never collide
with carbonui.Window's own attributes (it has header, content, sr, ...).
"""
import eveicon
from carbonui import uiconst, TextColor, ButtonVariant, Density
from carbonui.button.group import ButtonGroup, ButtonSizeMode
from carbonui.control.button import Button
from carbonui.control.buttonIcon import ButtonIcon
from carbonui.control.scrollContainer import ScrollContainer
from carbonui.control.tabGroup import TabGroup
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
from eve.client.script.ui.control.gauge import Gauge

API = None
STATE = {'alive': False, 'opened_for': set()}

QUESTIONS = (
    ('report', 'Status', eveicon.chat_bubble),
    ('mood', 'Morale', eveicon.people),
    ('next', 'Orders', eveicon.start_conversation),
)
CUT_FRAME = 'res:/UI/Texture/classes/Button/frame_cut_bottom_right.png'
TYPE_STEP_MS = 18
CONTRACT_POLL_MS = 5000
ARRIVAL_RANGE_M = 250000.0
# Marks the Contracts tab as not drawn yet. Distinct from None, which is the real "no contract" state.
NOT_DRAWN = object()


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


def _isk(amount):
    return '{:,} ISK'.format(int(amount or 0))


def _wait(seconds):
    minutes = max(1, int((seconds + 59) // 60))
    return '%d min' % minutes


def _section(parent, title, padTop=14):
    """Uppercase accent header with a hairline; returns the right-hand meta label."""
    row = Container(parent=parent, align=uiconst.TOTOP, height=20, padTop=padTop)
    TextDetail(parent=row, align=uiconst.CENTERLEFT, text=title, uppercase=True, bold=True, color=_accent(1.0))
    meta = TextDetail(parent=row, align=uiconst.CENTERRIGHT, text='', color=TextColor.SECONDARY)
    Line(parent=parent, align=uiconst.TOTOP, weight=1, color=_accent(0.35), padTop=3, padBottom=6)
    return meta


def _fact(parent, label, value):
    # The value is TOTOP so long names wrap inside the window instead of being clipped.
    row = ContainerAutoSize(parent=parent, align=uiconst.TOTOP, alignMode=uiconst.TOTOP, minHeight=20)
    TextDetail(parent=row, align=uiconst.TOPLEFT, top=2, text=label, uppercase=True, color=TextColor.SECONDARY)
    TextBody(parent=row, align=uiconst.TOTOP, padLeft=96, padBottom=2, text=value)


class CrewLinkWindow(Window):
    default_windowID = 'evejsCrewLink'
    default_caption = 'Crew Link'
    default_iconNum = eveicon.people
    default_width = 440
    default_height = 620
    default_minSize = (380, 480)
    default_isStackable = False
    # No close button: minimizing keeps the icon in the Neocom, so the window can
    # always be brought back. (A closed window would have no way to reopen.)
    default_isKillable = False

    def ApplyAttributes(self, attributes):
        Window.ApplyAttributes(self, attributes)
        self._clContract = None
        self._clContractKey = NOT_DRAWN
        self._clContractSeen = False
        self._clBoardInSec = 0
        self._clTaunted = set()
        self._clStatus = TextDetail(parent=self.content, align=uiconst.TOBOTTOM, padTop=6,
                                    color=TextColor.DISABLED, text='')
        self._BuildPilotCard()
        tabs = self._clTabs = TabGroup(name='evejsCrewLinkTabs', parent=self.content, groupID='evejsCrewLinkTabs',
                                       align=uiconst.TOTOP, padTop=8)
        self._clCrewPanel = Container(name='crewPanel', parent=self.content, align=uiconst.TOALL)
        self._clContractPanel = Container(name='contractPanel', parent=self.content, align=uiconst.TOALL)
        self._BuildCrewPanel(self._clCrewPanel)
        self._BuildContractPanel(self._clContractPanel)
        tabs.AddTab('Crew', self._clCrewPanel, tabID='crew')
        tabs.AddTab('Contracts', self._clContractPanel, tabID='contracts')
        self._clContactPanel = Container(name='contactPanel', parent=self.content, align=uiconst.TOALL)
        self._BuildContactPanel(self._clContactPanel)
        tabs.AddTab('Contacts', self._clContactPanel, tabID='contacts')
        self._clSupplyPanel = Container(name='supplyPanel', parent=self.content, align=uiconst.TOALL)
        self._BuildSupplyPanel(self._clSupplyPanel)
        tabs.AddTab('Requisition', self._clSupplyPanel, tabID='supply')
        tabs.AutoSelect()
        API.spawn(self.Refresh)
        API.spawn(self._ContractLoop)

    # ------------------------------------------------------------- pilot card
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
                                 left=84, width=300)
        self._clPilot = TextHeader(parent=text, align=uiconst.TOTOP, text='Establishing link...', bold=True)
        self._clShip = TextBody(parent=text, align=uiconst.TOTOP, color=TextColor.SECONDARY, text='')
        self._clPlace = TextDetail(parent=text, align=uiconst.TOTOP, color=TextColor.SECONDARY, text='')

    # -------------------------------------------------------------- crew tab
    def _BuildCrewPanel(self, panel):
        group = ButtonGroup(parent=panel, align=uiconst.TOBOTTOM, density=Density.COMPACT,
                            button_size_mode=ButtonSizeMode.STRETCH, padTop=10)
        self._clButtons = []
        for index, (topic, label, icon) in enumerate(QUESTIONS):
            self._clButtons.append(Button(parent=group, label=label, texturePath=icon, func=self.OnAsk, args=(topic,),
                                          variant=ButtonVariant.PRIMARY if index == 0 else ButtonVariant.NORMAL))
        self._clCrewMeta = _section(panel, 'CREW', padTop=8)
        self._clRoster = ContainerAutoSize(parent=panel, align=uiconst.TOTOP, alignMode=uiconst.TOTOP)
        self._clCommsMeta = _section(panel, 'COMMS')
        comms = Container(parent=panel, align=uiconst.TOALL)
        Frame(bgParent=comms, texturePath=CUT_FRAME, cornerSize=9, color=_accent(0.35))
        Fill(bgParent=comms, color=(0.0, 0.0, 0.0, 0.25))
        top = Container(parent=comms, align=uiconst.TOTOP, height=20, padding=(12, 10, 12, 0))
        self._clSignal = Sprite(parent=top, align=uiconst.CENTERLEFT, width=16, height=16,
                                texturePath=eveicon.signal_strength, color=_accent(1.0),
                                outputMode=uiconst.OUTPUT_COLOR_AND_GLOW, glowBrightness=0.4)
        self._clSpeaker = TextDetail(parent=top, align=uiconst.CENTERLEFT, left=24, uppercase=True, bold=True,
                                     color=TextColor.HIGHLIGHT, text='Channel open')
        self._clSpeech = TextBody(parent=comms, align=uiconst.TOTOP, padding=(12, 6, 12, 14),
                                  color=TextColor.NORMAL, text='Choose a question below to hail your crew.')

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

    def OnAsk(self, topic, *args):
        API.spawn(self._Ask, topic)

    def _Ask(self, topic):
        for button in self._clButtons:
            button.busy = True
        self._clSpeaker.text = 'Hailing crew...'
        self._clSpeech._clTicket = getattr(self._clSpeech, '_clTicket', 0) + 1  # stop an answer still typing
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
        self._clCommsMeta.text = 'AI voice' if answer.get('source') == 'ai' else 'Written line'
        self._Typewrite(self._clSpeech, answer.get('text') or '')
        API.log('crew answered %s via %s' % (topic, answer.get('source')))

    def _Typewrite(self, label, text):
        # One ticket per label: a newer text for the same label cancels the older
        # one, and the crew comms and the contract briefing never cut each other off.
        ticket = label._clTicket = getattr(label, '_clTicket', 0) + 1
        for end in range(2, len(text) + 2, 2):
            if self.destroyed or label.destroyed or label._clTicket != ticket:
                return
            label.text = text[:end] + ('' if end >= len(text) else '<color=0x88ffffff>_</color>')
            API.sleep(TYPE_STEP_MS)

    def OnRefresh(self, *args):
        API.spawn(self.Refresh)
        API.spawn(self._LoadContracts)
        API.spawn(self._LoadContacts)

    # --------------------------------------------------------- contracts tab
    def _BuildContractPanel(self, panel):
        self._clContractButtons = ButtonGroup(parent=panel, align=uiconst.TOBOTTOM, density=Density.COMPACT,
                                              button_size_mode=ButtonSizeMode.STRETCH, padTop=10)
        self._clContractBody = ScrollContainer(parent=panel, align=uiconst.TOALL, padTop=8)

    def _ContractLoop(self):
        # Keeps the tab current: an accepted contract is paid by the server the
        # moment its leader dies, wherever this window happens to be.
        while not self.destroyed:
            try:
                self._LoadContracts()
                self._CheckArrival()
            except Exception:
                API.log_exception('contract refresh')
            API.sleep(CONTRACT_POLL_MS)

    def _LoadContracts(self, reply=None):
        reply = reply or API.call('GetContracts')
        contract = reply.get('contract')
        shown = contract or reply.get('lastPaid')
        key = (shown.get('id'), shown.get('state')) if shown else None
        self._clContract = contract
        if reply.get('error'):
            API.notify(reply.get('error'))
        if key == self._clContractKey and not reply.get('error'):
            return
        previous = self._clContractKey if isinstance(self._clContractKey, tuple) else None
        justPaid = bool(previous and previous[1] in ('accepted', 'completed') and shown and shown.get('paid'))
        self._clContractKey = key
        self._clBoardInSec = reply.get('boardInSec') or 0
        # A contact's call that arrives while the window is already up (not one found on opening it).
        if contract and contract.get('state') == 'offered' and contract.get('incoming') and self._clContractSeen:
            API.notify('<b>Incoming transmission:</b> %s has work for you. See Crew Link, Contracts.' % contract.get('clientName'))
        self._clContractSeen = True
        self._RenderContract(shown, reply.get('completedCount') or 0, justPaid)
        # A contract changing state is what changes contacts (a new one, more or less trust).
        self._LoadContacts()

    def _SetContractButtons(self, buttons):
        self._clContractButtons.Flush()
        for label, func, variant, icon in buttons:
            Button(parent=self._clContractButtons, label=label, func=func, variant=variant, texturePath=icon)

    def _RenderContract(self, contract, completedCount, justPaid):
        body = self._clContractBody
        body.Flush()
        if contract is None:
            meta = _section(body, 'CONTRACTS', padTop=0)
            meta.text = '%d completed' % completedCount if completedCount else ''
            quiet = self._clBoardInSec
            TextBody(parent=body, align=uiconst.TOTOP, color=TextColor.SECONDARY,
                     text='Nothing on the books. The local channels are quiet for about %s; your contacts will call when they have work.' % _wait(quiet)
                     if quiet else 'Nothing on the books. Put the word out and see who needs a capsuleer.')
            self._SetContractButtons([('Find work', self.OnFindWork, ButtonVariant.PRIMARY, eveicon.start_conversation)])
            return

        state = contract.get('state')
        meta = _section(body, {'offered': 'CONTRACT OFFER', 'accepted': 'CONTRACT IN PROGRESS'}.get(state, 'CONTRACT COMPLETE'),
                        padTop=0)
        meta.text = contract.get('factionName') or ''
        TextHeader(parent=body, align=uiconst.TOTOP, text=contract.get('title') or 'Contract', bold=True)
        client = '%s  -  %s' % (contract.get('clientName'), contract.get('clientRole'))
        if contract.get('returningClient'):
            client += '<br><color=%s>Returning client: %s</color>' % (_hex(_accent()), contract.get('clientTierLabel'))
            if contract.get('payBonusPercent'):
                client += '  -  pays %d%% over the going rate' % contract.get('payBonusPercent')
        TextDetail(parent=body, align=uiconst.TOTOP, color=TextColor.SECONDARY, padBottom=8, text=client)

        panel = ContainerAutoSize(parent=body, align=uiconst.TOTOP, alignMode=uiconst.TOTOP)
        Frame(bgParent=panel, texturePath=CUT_FRAME, cornerSize=9, color=_accent(0.35))
        Fill(bgParent=panel, color=(0.0, 0.0, 0.0, 0.25))
        paid = bool(contract.get('paid'))
        spoken = contract.get('debrief') if paid else contract.get('briefing')
        words = TextBody(parent=panel, align=uiconst.TOTOP, padding=(12, 10, 12, 12), text='')
        if justPaid or state == 'offered':
            API.spawn(self._Typewrite, words, spoken or '')
        else:
            words.text = spoken or ''

        security = contract.get('security')
        where = '<color=%s>%.1f</color>  %s' % (_hex(_security_color(security)), security or 0.0, contract.get('systemName'))
        jumps = contract.get('jumps') or 0
        where += '  -  %s' % ('this system' if jumps == 0 else '%d jump%s' % (jumps, '' if jumps == 1 else 's'))
        facts = ContainerAutoSize(parent=body, align=uiconst.TOTOP, alignMode=uiconst.TOTOP, padTop=10)
        _fact(facts, 'Target', '%s  <color=0x88ffffff>"%s"</color>' % (contract.get('bossName'), contract.get('bossEpithet')))
        _fact(facts, 'Hideout', '%s, near %s' % (contract.get('siteName'), contract.get('anchorName') or 'deep space'))
        _fact(facts, 'System', where)
        _fact(facts, 'Opposition', 'about %d ships, leader in a %s' % (contract.get('hostileCount') or 0, contract.get('bossHull')))
        _fact(facts, 'Payment', '<color=%s>%s</color>' % (_hex(eveColor.LEAFY_GREEN), _isk(contract.get('rewardIsk'))))
        cache = contract.get('cache') or []
        if cache:
            _fact(facts, 'Strongbox', ', '.join(cache))

        if paid:
            TextDetail(parent=body, align=uiconst.TOTOP, padTop=10, color=eveColor.LEAFY_GREEN,
                       text='PAID  -  %s transferred to your wallet' % _isk(contract.get('rewardIsk')))
            self._SetContractButtons([('Find more work', self.OnFindWork, ButtonVariant.PRIMARY, eveicon.start_conversation)])
            if justPaid:
                API.notify('Contract complete: %s. %s paid.' % (contract.get('title'), _isk(contract.get('rewardIsk'))))
        elif state == 'offered':
            if contract.get('expiresInSec'):
                TextDetail(parent=body, align=uiconst.TOTOP, padTop=10, color=TextColor.SECONDARY,
                           text='%sThis offer goes to someone else in about %s.' % (
                               'They called you. ' if contract.get('incoming') else '', _wait(contract.get('expiresInSec'))))
            self._SetContractButtons([
                ('Accept', self.OnAccept, ButtonVariant.PRIMARY, eveicon.checkmark),
                ('Decline', self.OnAbandon, ButtonVariant.GHOST, eveicon.close),
            ])
        elif state == 'completed':
            TextDetail(parent=body, align=uiconst.TOTOP, padTop=10, color=TextColor.SECONDARY,
                       text='Kill confirmed. Payment is being processed.')
            self._SetContractButtons([])
        else:
            TextDetail(parent=body, align=uiconst.TOTOP, padTop=10, color=TextColor.SECONDARY,
                       text='The hideout is saved in your locations (People & Places) and shows on the scanner in %s. '
                            'Kill %s to complete the contract.' % (contract.get('systemName'), contract.get('bossName')))
            self._SetContractButtons([
                ('Set destination', self.OnSetDestination, ButtonVariant.PRIMARY, eveicon.location),
                ('Abandon', self.OnAbandon, ButtonVariant.GHOST, eveicon.close),
            ])

    def _ContractAction(self, method, *args):
        for button in list(self._clContractButtons.buttons):
            button.busy = True
        try:
            reply = API.call(method, *args)
        except Exception:
            self._clContractKey = NOT_DRAWN  # force a redraw so the buttons come back
            raise
        # The "putting the word out" placeholder is on screen, so always redraw from the reply.
        self._clContractKey = NOT_DRAWN
        self._LoadContracts(reply)

    def OnFindWork(self, *args):
        self._clContractBody.Flush()
        _section(self._clContractBody, 'CONTRACTS', padTop=0)
        TextBody(parent=self._clContractBody, align=uiconst.TOTOP, color=TextColor.SECONDARY,
                 text='Putting the word out on the local channels...')
        API.spawn(self._ContractAction, 'RequestContract')

    def OnAccept(self, *args):
        if self._clContract:
            API.spawn(self._ContractAction, 'AcceptContract', self._clContract.get('id'))

    def OnAbandon(self, *args):
        if self._clContract:
            API.spawn(self._ContractAction, 'AbandonContract', self._clContract.get('id'))

    def OnSetDestination(self, *args):
        if self._clContract:
            sm.StartService('starmap').SetWaypoint(self._clContract.get('systemID'), clearOtherWaypoints=True)

    # ----------------------------------------------------------- contacts tab
    def _BuildContactPanel(self, panel):
        comms = ContainerAutoSize(parent=panel, align=uiconst.TOBOTTOM, alignMode=uiconst.TOTOP, padTop=8, minHeight=64)
        Frame(bgParent=comms, texturePath=CUT_FRAME, cornerSize=9, color=_accent(0.35))
        Fill(bgParent=comms, color=(0.0, 0.0, 0.0, 0.25))
        self._clHailSpeaker = TextDetail(parent=comms, align=uiconst.TOTOP, padding=(12, 10, 12, 0), uppercase=True,
                                         bold=True, color=TextColor.HIGHLIGHT, text='Comms idle')
        self._clHailSpeech = TextBody(parent=comms, align=uiconst.TOTOP, padding=(12, 4, 12, 12),
                                      text='Hail a contact to open a channel.')
        self._clContactBody = ScrollContainer(parent=panel, align=uiconst.TOALL, padTop=8)

    def _LoadContacts(self):
        try:
            contacts = API.call('GetContacts') or []
        except Exception:
            API.log_exception('contacts are unavailable')
            return
        if self.destroyed:
            return
        body = self._clContactBody
        body.Flush()
        meta = _section(body, 'CONTACTS', padTop=0)
        meta.text = '%d known' % len(contacts) if contacts else ''
        if not contacts:
            TextBody(parent=body, align=uiconst.TOTOP, color=TextColor.SECONDARY,
                     text='No one out here knows your name yet. Finish a contract and the client will remember you.')
            return
        for contact in contacts:
            card = ContainerAutoSize(parent=body, align=uiconst.TOTOP, alignMode=uiconst.TOTOP, padBottom=6)
            PanelUnderlay(bgParent=card)
            soured = not contact.get('willOffer')
            Fill(parent=card, align=uiconst.TOLEFT, width=2, color=eveColor.DANGER_RED if soured else _accent(0.9))
            TextHeader(parent=card, align=uiconst.TOTOP, padding=(12, 8, 12, 0), text=contact.get('name'), bold=True)
            where = contact.get('homeSystemName')
            TextDetail(parent=card, align=uiconst.TOTOP, padding=(12, 0, 12, 6), color=TextColor.SECONDARY,
                       text=contact.get('role') + ('  -  %s' % where if where else ''))
            Gauge(parent=card, align=uiconst.TOTOP, padding=(12, 0, 12, 0), gaugeHeight=4,
                  color=eveColor.DANGER_RED if soured else _accent(1.0),
                  value=max(0.02, min(1.0, abs(contact.get('trust') or 0) / 100.0)))
            standing = contact.get('tierLabel') or ''
            if contact.get('payBonusPercent'):
                standing += '  -  pays %d%% extra' % contact.get('payBonusPercent')
            jobs = contact.get('jobsCompleted') or 0
            standing += '  -  %d job%s done' % (jobs, '' if jobs == 1 else 's')
            TextDetail(parent=card, align=uiconst.TOTOP, padding=(12, 4, 12, 0), text=standing,
                       color=eveColor.DANGER_RED if soured else TextColor.NORMAL)
            if contact.get('lastLine'):
                TextBody(parent=card, align=uiconst.TOTOP, padding=(12, 4, 12, 0), color=TextColor.SECONDARY,
                         text=contact.get('lastLine'))
            row = Container(parent=card, align=uiconst.TOTOP, height=32, padding=(12, 6, 12, 8))
            resting = contact.get('availableInSec') or 0
            Button(parent=row, align=uiconst.CENTERLEFT, enabled=not soured and not resting,
                   label='Will call in ~%s' % _wait(resting) if resting and not soured else 'Ask for work',
                   variant=ButtonVariant.PRIMARY, texturePath=eveicon.start_conversation,
                   func=self.OnAskContact, args=(contact.get('id'),))
            Button(parent=row, align=uiconst.CENTERLEFT, left=200, label='Hail', texturePath=eveicon.chat_bubble,
                   func=self.OnHailContact, args=(contact.get('id'),))

    def OnHailContact(self, contactID, *args):
        API.spawn(self._HailContact, contactID)

    def _HailContact(self, contactID):
        self._clHailSpeaker.text = 'Opening channel...'
        self._clHailSpeech._clTicket = getattr(self._clHailSpeech, '_clTicket', 0) + 1
        self._clHailSpeech.text = ''
        reply = API.call('HailContact', contactID)
        speaker = reply.get('speaker')
        self._clHailSpeaker.text = '%s  -  %s' % (speaker, reply.get('role')) if speaker else 'No answer'
        self._Typewrite(self._clHailSpeech, reply.get('text') or '')
        API.log('hailed %s via %s' % (contactID, reply.get('source')))

    def OnAskContact(self, contactID, *args):
        if self._clContract:
            API.notify('You already have a contract open. Finish or abandon it before asking for more work.')
            return
        # The offer is shown on the Contracts tab, like any other.
        try:
            self._clTabs.SelectByID('contracts')
        except Exception:
            API.log_exception('switching to the Contracts tab')
        self._clContractBody.Flush()
        _section(self._clContractBody, 'CONTRACTS', padTop=0)
        TextBody(parent=self._clContractBody, align=uiconst.TOTOP, color=TextColor.SECONDARY,
                 text='Calling your contact...')
        API.spawn(self._ContractAction, 'RequestContract', contactID)

    # -------------------------------------------------------- requisition tab
    def _BuildSupplyPanel(self, panel):
        self._clSupplyBody = ScrollContainer(parent=panel, align=uiconst.TOALL, padTop=8)
        API.spawn(self._LoadSupply)

    def _LoadSupply(self, notes=None, ok=True):
        loadouts = API.call('GetLoadouts')
        body = self._clSupplyBody
        body.Flush()
        meta = _section(body, 'TEST SHIPS', padTop=0)
        meta.text = 'Development aid'
        TextBody(parent=body, align=uiconst.TOTOP, color=TextColor.SECONDARY, padBottom=8,
                 text='A fully fitted hull and all skills at V, delivered to your hangar. Dock at a station first.')
        for loadout in loadouts:
            card = ContainerAutoSize(parent=body, align=uiconst.TOTOP, alignMode=uiconst.TOTOP, padBottom=6)
            PanelUnderlay(bgParent=card)
            Fill(parent=card, align=uiconst.TOLEFT, width=2, color=_accent(0.9))
            TextHeader(parent=card, align=uiconst.TOTOP, padding=(12, 8, 12, 0), text=loadout.get('label'), bold=True)
            TextBody(parent=card, align=uiconst.TOTOP, padding=(12, 2, 12, 8), color=TextColor.SECONDARY,
                     text=loadout.get('summary'))
            row = Container(parent=card, align=uiconst.TOTOP, height=32, padding=(12, 0, 12, 10))
            Button(parent=row, align=uiconst.CENTERLEFT, label='Requisition %s' % loadout.get('label'),
                   variant=ButtonVariant.PRIMARY, texturePath=eveicon.spaceship_command,
                   func=self.OnRequisition, args=(loadout.get('key'),))
        if notes:
            _section(body, 'DELIVERY' if ok else 'NOT DELIVERED')
            for note in notes:
                TextBody(parent=body, align=uiconst.TOTOP, padBottom=4, text=note,
                         color=TextColor.NORMAL if ok else eveColor.WARNING_ORANGE)

    def OnRequisition(self, key, *args):
        API.spawn(self._Requisition, key)

    def _Requisition(self, key):
        self._clSupplyBody.Flush()
        _section(self._clSupplyBody, 'TEST SHIPS', padTop=0)
        TextBody(parent=self._clSupplyBody, align=uiconst.TOTOP, color=TextColor.SECONDARY,
                 text='The quartermaster is fitting out your ship...')
        notes, ok = ['The requisition did not go through. Try again.'], False
        try:
            reply = API.call('Requisition', key)
            notes, ok = reply.get('notes') or [], bool(reply.get('ok'))
        finally:
            self._LoadSupply(notes, ok)
        API.log('requisition %s ok=%s' % (key, ok))
        API.spawn(self.Refresh)

    def _CheckArrival(self):
        # The leader hails you once, when you land on grid at the hideout.
        contract = self._clContract
        if not contract or contract.get('state') != 'accepted' or contract.get('id') in self._clTaunted:
            return
        if session.solarsystemid != contract.get('systemID') or not session.shipid:
            return
        ballpark = sm.GetService('michelle').GetBallpark()
        ball = ballpark.GetBall(session.shipid) if ballpark else None
        if ball is None:
            return
        dx, dy, dz = ball.x - contract.get('x'), ball.y - contract.get('y'), ball.z - contract.get('z')
        if (dx * dx + dy * dy + dz * dz) ** 0.5 > ARRIVAL_RANGE_M:
            return
        self._clTaunted.add(contract.get('id'))
        API.notify('<b>%s:</b> %s' % (contract.get('bossName'), contract.get('taunt')))
        API.log('arrived at %s; taunt shown' % contract.get('siteName'))


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
