# -*- coding: utf-8 -*-
"""Neocom button for Crew Link: one permanent icon that opens / toggles the window.

Why this exists: the Neocom only shows a window while it is open or minimized
(a temporary "tab" that is deleted on close), so a closed Crew Link window had
no way back. This mod adds a permanent button through the Neocom's own plug-in
point for fixed buttons (the strip above the clock, where the store and redeem
buttons live): NeocomSvc.RegisterFixedButtonExtension.

Why that mechanism: the fixed strip is rebuilt from the registered extensions
every time the Neocom is built or rebuilt, and it is never saved. Nothing is
written to the player's Neocom layout, so removing this file leaves no trace.

The click does not use the game's command system (commands are rebuilt on
login and would lose ours); it calls the Crew Link window class directly, and
looks that class up at click time because crew_link.py reloads on its own.

The button is only shown while crew_link is loaded, so there is never an icon
that does nothing.
"""
import sys

API = None
STATE = {
    'alive': False,    # False once unload() ran: everything of this load goes quiet
    'token': None,     # identifies the running check loop
    'classes': None,   # classes built from client modules on first use
    'ext': None,       # our registered Neocom extension
    'missing': 0,      # checks in a row with the button missing from the strip
    'nudges': 0,       # rebuilds asked for because of that
    'unlinked': 0,     # checks in a row with a tracked window not linked to the button
    'present': None,   # was crew_link loaded at the last check
}

CREW_MODULE = 'evejs_mods.crew_link'  # the loader registers each mod as evejs_mods.<file name>
CREW_CLASS = 'CrewLinkWindow'
# Not 'evejsCrewLink': that is the window's own id, which the Neocom also uses
# as the id of the per-window node, and button lookups by id would mix them up.
BTN_ID = 'evejsCrewLinkNeocomButton'
# Marks our objects so copies left by an earlier load can be found: after a hot
# reload their classes are different objects, so isinstance cannot find them.
TAG = 'evejs.neocom_button.crew_link'
FALLBACK_LABEL = 'Crew Link'
BUTTON_CLASSES_MODULE = 'eve.client.script.ui.shared.neocom.neocom.neocomButtonClasses'
POLL_MS = 1000
SLOW_POLL_MS = 30000
MAX_NUDGES = 3


def _log(message):
    try:
        API.log(message)
    except Exception:
        pass


def _log_exc(context):
    # Must be called from inside an except block: it logs the active traceback.
    try:
        API.log_exception(context)
    except Exception:
        pass


def _window_class():
    """The CURRENT CrewLinkWindow class, or None when crew_link is not loaded.

    Looked up on every use and never stored: crew_link.py is re-executed on hot
    reload, which replaces the class object.
    """
    module = sys.modules.get(CREW_MODULE)
    if module is None:
        return None
    return getattr(module, CREW_CLASS, None)


def _caption():
    return getattr(_window_class(), 'default_caption', None) or FALLBACK_LABEL


def _tracked_window_class(node=None):
    # Answers BtnDataNode.wndCls. The Neocom matches windows to buttons by class
    # object, so this must always be the live class. None once we are unloaded,
    # so a dying button no longer claims the window. Runs inside Neocom code on
    # every window event: it must never raise.
    try:
        if not STATE['alive']:
            return None
        return _window_class()
    except Exception:
        return None


def _toggle_window():
    try:
        cls = _window_class()
        if cls is None:
            # Normally unreachable: the button is hidden while crew_link is
            # not loaded. Possible for up to one check after it went away.
            _log('click ignored: %s.%s is not loaded' % (CREW_MODULE, CREW_CLASS))
            return
        wnd = cls.GetIfOpen()
        if not wnd or wnd.destroyed:
            cls.Open()
        elif wnd.IsMinimized() or wnd.minimizable:
            # Same as a stock window button: restore if minimized, bring to the
            # front if covered, minimize if already in front. Works whether or
            # not crew_link allows the window to be closed.
            wnd.ToggleMinimize()
        else:
            cls.ToggleOpenClose()
    except Exception:
        _log_exc('toggling the Crew Link window failed')


def _build_classes():
    # Imported here, not at the top of the file: the mod may be loaded at the
    # login screen, and a failed import must end up in our log through
    # api.log_exception instead of stopping the mod from loading.
    import eveicon
    from eve.client.script.ui.shared.neocom.neocom import neocomConst
    from eve.client.script.ui.shared.neocom.neocom import neocomButtonClasses
    from eve.client.script.ui.shared.neocom.neocom.btnData.btnDataNode import BtnDataNode
    from eve.client.script.ui.shared.neocom.neocom.buttons.buttonWindow import ButtonWindow
    from eve.client.script.ui.shared.neocom.neocom.fixedButtonExtension import FixedButtonExtension

    class CrewLinkBtnData(BtnDataNode):
        evejs_tag = TAG

        def __init__(self, parent):
            cls = _window_class()
            # BTNTYPE_CMD is what the stock fixed buttons use. If our button
            # class were ever missing from the class table, this type falls back
            # to the stock ButtonWindow instead of an unknown-type KeyError that
            # would break the whole strip. No cmdName: we never use a command.
            # No label either, like the stock store button: the game's help
            # pointer list reads the labels of fixed buttons as localization
            # paths and would show "[no label: Crew Link]". Without a label it
            # skips the button; the tooltip text comes from our button class.
            BtnDataNode.__init__(
                self, parent=parent, btnID=BTN_ID, btnType=neocomConst.BTNTYPE_CMD,
                iconPath=getattr(cls, 'default_iconNum', None) or eveicon.people,
                isRemovable=False, isDraggable=False)
            # BtnDataNode is an old-style class, so its "self.wndCls = None"
            # landed in the instance dict and hides the property below.
            self.__dict__.pop('wndCls', None)

        # With wndCls matching, the Neocom attaches the open / minimized Crew
        # Link window to this button instead of creating its temporary tab (no
        # second icon), and highlights the button while the window is open.
        # The setter only exists so the assignment in BtnDataNode.__init__
        # could not fail if the base class were new-style.
        wndCls = property(_tracked_window_class, lambda self, value: None)

        def IsButtonInScope(self):
            # The stock check hides a command-type button that has no command.
            return True

        def GetMenu(self):
            # No "blink" / "icon colour" entries: both save a per-character
            # setting under our button id, which would be junk without the mod.
            return []

    class CrewLinkNeocomButton(ButtonWindow):
        evejs_tag = TAG

        def OnClickCommand(self):
            # The stock version runs a game command by name when no window is
            # open, and fails for a button without one. In a tasklet, like the
            # stock button, because opening a window can block.
            try:
                API.spawn(_toggle_window)
            except Exception:
                _log_exc('Neocom button click failed')

        def LoadTooltipPanel(self, tooltipPanel, *args):
            # The stock tooltip needs a command or a node label; we have neither.
            try:
                tooltipPanel.LoadGeneric3ColumnTemplate()
                tooltipPanel.AddLabelMedium(text=_caption())
            except Exception:
                _log_exc('Neocom button tooltip failed')

        def GetMenu(self):
            # Right-click shows the open window's own menu and nothing else
            # (see CrewLinkBtnData.GetMenu). None is what the stock button
            # returns when it has no menu.
            try:
                if self.IsSingleWindow():
                    wnd = self.GetWindow()
                    if wnd and not wnd.destroyed:
                        return wnd.GetMenu()
            except Exception:
                _log_exc('Neocom button menu failed')
            return None

    class CrewLinkNeocomExtension(FixedButtonExtension):
        evejs_tag = TAG

        @property
        def is_visible(self):
            # Hidden while crew_link is not loaded (deleted, or failed to
            # compile), so there is never an icon that does nothing. A copy
            # that could not be unregistered hides itself too. Guarded because
            # Python 2 turns a collected module's globals into None, and this
            # is read while the Neocom is being built.
            try:
                return bool(STATE['alive']) and _window_class() is not None
            except Exception:
                return False

        def create_button_data(self, parent):
            # Called by the Neocom whenever it builds the fixed strip (login,
            # dock, undock, reset). An exception here would stop the Neocom
            # from being built, so nothing may escape.
            try:
                _install_button_class()
                return CrewLinkBtnData(parent)
            except Exception:
                _log_exc('creating the Neocom button failed')
                _drop_half_built(parent)
            return None

    return {
        'button': CrewLinkNeocomButton,
        'extension': CrewLinkNeocomExtension,
        'registry': neocomButtonClasses.NEOCOM_BUTTON_CLASSES_BY_ID,
        'BTNTYPE_WINDOW': neocomConst.BTNTYPE_WINDOW,
    }


def _classes():
    if STATE['classes'] is None:
        STATE['classes'] = _build_classes()
    return STATE['classes']


def _install_button_class():
    # The Neocom picks a button's UI class from this dict by button id before
    # it looks at the type. The dict is read on every rebuild, so keep it
    # pointing at this load's class.
    classes = _classes()
    registry = classes['registry']
    if registry.get(BTN_ID) is not classes['button']:
        registry[BTN_ID] = classes['button']


def _drop_half_built(parent):
    # BtnDataNode.__init__ adds itself to the parent before it has finished; a
    # node that failed after that point must not stay in the strip.
    try:
        for child in list(parent.children):
            if getattr(child, 'id', None) == BTN_ID:
                parent.RemoveChild(child)
    except Exception:
        _log_exc('removing a half-built Neocom button failed')


def _extensions(neocom):
    extensions = getattr(neocom, '_fixedButtonExtensions', None)
    if extensions is None:
        raise RuntimeError('the neocom service has no _fixedButtonExtensions list')
    return extensions


def _unregister_tagged(neocom, keep=None):
    # By tag, not by identity: this also removes copies left behind by an
    # earlier load of this file whose unload did not complete.
    for extension in list(_extensions(neocom)):
        if extension is keep or getattr(extension, 'evejs_tag', None) != TAG:
            continue
        try:
            neocom.UnregisterFixedButtonExtension(extension)
        except ValueError:
            pass  # already gone
        except Exception:
            _log_exc('unregistering a Neocom extension failed')


def _is_registered(neocom, extension):
    for each in _extensions(neocom):
        if each is extension:
            return True
    return False


def _is_changing(wnd):
    # True while the window runs its minimize / restore code. The minimize
    # animation takes 0.25 s, during which the window already reports
    # "minimized" although the Neocom has not been told yet.
    return bool(getattr(wnd, '_changing', False))


def _is_tracked(wnd):
    # The Neocom's own rule: a window that cannot be closed is tracked only
    # while minimized. A window in the middle of its minimize / restore
    # animation counts as tracked so we do not fight the Neocom over it.
    return bool(wnd.IsKillable() or wnd.IsMinimized() or _is_changing(wnd))


def _prune_window_children(node, wnd):
    """Keep at most one child node on the button, and only for the live window.

    The Neocom's own bookkeeping is not enough here: it adds a child on every
    "minimized" notice without looking for an existing one, its cleanup skips
    entries because it removes while iterating, and the window events of a
    reloaded crew_link carry the old class, which no longer matches ours.
    Duplicates and children of dead windows therefore never go away by
    themselves. wnd is the live Crew Link window, or None.
    Returns True when the live window is linked to the button afterwards.
    """
    tracked = wnd is not None and _is_tracked(wnd)
    linked = False
    for child in list(node.children):
        if tracked and not linked and getattr(child, 'wnd', None) is wnd:
            linked = True
        else:
            child.Remove()
    if linked:
        if not node.IsOpen():
            node.SetOpen()
    elif node.IsOpen():
        node.SetClosed()
    if wnd is None and node.IsActive():
        # The "lost focus" notice of a reloaded / removed crew_link window
        # did not match our class either.
        node.SetInactive()
    return linked


def _sync_window_link(neocom, node, classes):
    """Keep the button's window link correct: exactly one child node for a
    tracked Crew Link window, none otherwise."""
    cls = _window_class()
    wnd = cls.GetIfOpen() if cls is not None else None
    if not wnd or wnd.destroyed or wnd.__class__ is not cls:
        wnd = None
    linked = _prune_window_children(node, wnd)
    if wnd is None or linked:
        STATE['unlinked'] = 0
        return
    main = neocom.GetMainBtnDataRoot()
    tab = main.GetBtnDataByWndCls(cls) if main is not None else None
    if tab is not None:
        STATE['unlinked'] = 0
        if tab.btnType != classes['BTNTYPE_WINDOW']:
            return
        # A temporary tab owns the window (the main bar is searched before the
        # fixed strip). Move its window onto our button and drop the tab, the
        # way the Neocom merges buttons itself, so there is only one icon.
        for child in list(tab.children):
            child.SetParent(node)
        tab.Remove()
        _prune_window_children(node, wnd)
        _log('moved the temporary Crew Link tab onto the permanent button')
        return
    if _is_changing(wnd) or not (wnd.IsKillable() or wnd.IsMinimized()):
        # Mid-animation (the Neocom links the window when it ends), or a
        # window the Neocom does not track either.
        STATE['unlinked'] = 0
        return
    # The Neocom links a window itself, from a notice that is delivered on
    # another tasklet after the window changed. Only step in when the link is
    # still missing on two checks in a row, which means the notice is long
    # gone: the strip was rebuilt (dock / undock makes a node without
    # children). Stepping in earlier could add a second child for one window.
    STATE['unlinked'] += 1
    if STATE['unlinked'] < 2:
        return
    STATE['unlinked'] = 0
    neocom.ConstructWindowButtonData(wnd)


def _hand_window_back(neocom):
    # Our button is going away. Give an open Crew Link window an ordinary
    # temporary tab, or a minimized window would have no icon to restore it.
    # STATE['alive'] is already False here, so our node no longer claims the
    # window and the Neocom creates the tab in the main bar.
    cls = _window_class()
    if cls is None or not neocom.IsAvailable():
        return
    wnd = cls.GetIfOpen()
    if not wnd or wnd.destroyed:
        return
    if _is_changing(wnd):
        return  # mid-animation: the Neocom's own notice creates the tab
    if not wnd.IsKillable() and not wnd.IsMinimized():
        return
    main = neocom.GetMainBtnDataRoot()
    if main is None or main.GetBtnDataByWndCls(wnd.__class__) is not None:
        return
    neocom.ConstructWindowButtonData(wnd)


def _tick():
    if not getattr(session, 'charid', None):
        return  # login screen or character selection: nothing to do yet
    if not sm.IsServiceRunning('neocom'):
        return  # do not start the service ourselves; the game does on entry
    classes = _classes()
    neocom = sm.GetService('neocom')
    _install_button_class()
    extension = STATE['ext']
    _unregister_tagged(neocom, keep=extension)
    present = _window_class() is not None
    if extension is None or not _is_registered(neocom, extension):
        # First time, or the Neocom dropped every extension (it does on logoff
        # to character selection). A fresh object each time, so the service
        # never sees the same extension twice. If the Neocom is not built yet
        # this only stores it and the Neocom creates the button when it is
        # built; if it is, the strip is rebuilt right away.
        if not STATE['alive']:
            return
        extension = classes['extension']()
        STATE['ext'] = extension
        STATE['missing'] = 0
        STATE['nudges'] = 0
        STATE['unlinked'] = 0
        STATE['present'] = present
        neocom.RegisterFixedButtonExtension(extension)
        _log('Crew Link button registered with the Neocom')
        return
    if present != STATE['present']:
        # crew_link appeared or went away: show / hide the button. Firing the
        # extension's signal is the stock way to ask for a strip rebuild.
        STATE['present'] = present
        STATE['missing'] = 0
        STATE['nudges'] = 0
        STATE['unlinked'] = 0
        _log('crew_link is %s; %s the Neocom button' % (
            'loaded' if present else 'not loaded', 'showing' if present else 'hiding'))
        extension.on_visible_changed(extension)
        return
    if not present or not neocom.IsAvailable():
        return
    root = neocom.GetFixedButtonData()
    node = root.GetBtnDataByTypeAndID(BTN_ID) if root is not None else None
    if node is None:
        # Registered but not in the strip. Rebuilds are asynchronous, so wait
        # a few checks, then ask for a rebuild. Only a few times: a button that
        # cannot be built must not make the strip flicker forever.
        STATE['missing'] += 1
        if STATE['missing'] >= 3 and STATE['nudges'] < MAX_NUDGES:
            STATE['missing'] = 0
            STATE['nudges'] += 1
            _log('button missing from the Neocom; asking for a rebuild (%d of %d)' % (STATE['nudges'], MAX_NUDGES))
            extension.on_visible_changed(extension)
        return
    STATE['missing'] = 0
    STATE['nudges'] = 0
    _sync_window_link(neocom, node, classes)


def _run(token):
    failures = 0
    while STATE['alive'] and STATE['token'] is token:
        try:
            _tick()
            failures = 0
        except Exception:
            failures += 1
            if failures <= 5 or failures % 20 == 0:
                _log_exc('Neocom button check failed (%d in a row)' % failures)
        # Not inside the try: if sleeping itself failed, a loop that swallowed
        # the error would never yield and would freeze the client.
        API.sleep(SLOW_POLL_MS if failures >= 5 else POLL_MS)


def _remove_button():
    try:
        if sm.IsServiceRunning('neocom'):
            neocom = sm.GetService('neocom')
            _unregister_tagged(neocom)
            _hand_window_back(neocom)
    except Exception:
        _log_exc('unregistering the Neocom button failed')
    STATE['ext'] = None
    # Last, and only if the entry is ours: until the Neocom has rebuilt the
    # strip, the old node may still be drawn once more and needs a class.
    module = sys.modules.get(BUTTON_CLASSES_MODULE)
    registry = getattr(module, 'NEOCOM_BUTTON_CLASSES_BY_ID', None)
    if registry is not None and getattr(registry.get(BTN_ID), 'evejs_tag', None) == TAG:
        registry.pop(BTN_ID, None)


def load(api):
    global API
    API = api
    # The token stops an older loop of this same module copy if load() were
    # ever called twice without unload().
    token = object()
    STATE['alive'] = True
    STATE['token'] = token
    try:
        # Everything happens in the tasklet: at the login screen it waits for a
        # character, and after a logoff it puts the button back.
        api.spawn(_run, token)
    except Exception:
        _log_exc('could not start the Neocom button tasklet')


def unload():
    STATE['alive'] = False
    STATE['token'] = None
    try:
        _remove_button()
    except Exception:
        _log_exc('removing the Neocom button failed')
