"use strict";

// Obsidian's Live Preview table editor (checked on 1.15.1) treats every table
// whose Markdown source is not column-aligned as malformed. As soon as one of
// its cells is focused, by a click or by moving the cursor through the table,
// it rewrites the whole table with padded columns. Nothing was edited, yet Git
// shows every row as changed, and tables written compactly by scripts, agents
// or other plugins never stay compact. Obsidian has no setting for this.
//
// The rewrite cannot be vetoed once it starts: the table editor opens its cell
// editor against the padded text before it dispatches the change, so dropping
// the change would leave that cell editor pointing at the wrong offsets. This
// guard therefore keeps the table editor from being entered at all:
//
// - Mouse: pointer and mouse presses inside a rendered table are stopped before
//   the table editor sees them. Click events still pass, so links keep working.
// - Cursor: a cursor that would move into a table, that a note opens with inside one,
//   or that a reload of the note leaves inside one, lands outside it.
// - Buttons: clicks on the table editor's add-row and add-column buttons, which sit
//   beside the table and insert into it, are stopped. styles.css also hides them.
// - Drags: a table refuses drops, because a drag over a cell opens its cell editor.
//
// Tables are then edited in Source mode or in another plugin's own view. A table
// whose cell editor is already open (one being typed in Live Preview) is left alone.
//
// Tables, their buttons, their cell editor and the reload of a note are recognized
// by internal Obsidian names, below, and the switch into Live Preview by an internal
// effect (see f_turnsLivePreviewOn). If Obsidian changes one, that part stops
// matching and its own table editor returns.
const TABLE_ROW_NODE_NAME = "HyperMD-table-row";
const RENDERED_TABLE_SELECTOR = ".cm-table-widget table";
// The table editor edits a cell in a small editor of its own, nested in the table.
const CELL_EDITOR_SELECTOR = ".cm-table-widget .cm-editor";
// Obsidian gives this user event to the transaction that reloads a note changed on disk.
const RELOAD_USER_EVENT = "set";
// CodeMirror parses a long note lazily, so the parse may not have reached the place the
// cursor jumps to. This is the most time one cursor move may spend finishing it.
const PARSE_BUDGET_MILLISECONDS = 100;
const BLOCKED_POINTER_EVENT_TYPES = ["pointerdown", "mousedown"];
// Elements whose own reaction to a press is kept, so that links and controls rendered
// inside a cell (by Obsidian or by another plugin) keep working.
const PRESS_DEFAULT_KEPT_SELECTOR = "a, button, input, select, textarea, label, summary";
const BLOCKED_DRAG_EVENT_TYPES = ["dragenter", "dragover", "drop"];
// Hiding these buttons in styles.css is cosmetic: a theme, a snippet or a change in
// Obsidian's own rules can show them again, so their click is stopped here as well.
const TABLE_EDITOR_BUTTON_SELECTOR = ".cm-table-widget .table-row-btn, .cm-table-widget .table-col-btn";
const BLOCKED_BUTTON_EVENT_TYPES = ["click"];
// styles.css hides the table editor's own row, column and drag controls under this class.
// CodeMirror rewrites the editor element's class list itself, so the class is declared
// through its editorAttributes facet; one added by hand is lost on the next focus change.
const GUARDED_EDITOR_CLASS = "atpath-table-guard";

function f_isTableRowLine(tree, line) {
  let isTableRow = false;
  tree.iterate({
    from: line.from,
    to: line.to,
    enter: node => {
      if (node.from === line.from && node.type.name.includes(TABLE_ROW_NODE_NAME)) isTableRow = true;
      return !isTableRow;
    },
  });
  return isTableRow;
}

// Returns { from, to } of the table whose source contains `position`, or null.
function f_findTableRange(tree, doc, position) {
  const f_isRow = lineNumber => lineNumber >= 1 && lineNumber <= doc.lines && f_isTableRowLine(tree, doc.line(lineNumber));
  const lineNumber = doc.lineAt(position).number;
  if (!f_isRow(lineNumber)) return null;
  let firstLine = lineNumber;
  let lastLine = lineNumber;
  while (f_isRow(firstLine - 1)) firstLine--;
  while (f_isRow(lastLine + 1)) lastLine++;
  return { from: doc.line(firstLine).from, to: doc.line(lastLine).to };
}

// A delimiter row such as "| --- | :-: |", told from its text alone.
function f_isDelimiterRowText(text) {
  return /^[\s|:-]+$/.test(text) && text.includes("|") && text.includes("-");
}

// Finds the table around `position` from the text alone, for a document that has no
// syntax tree yet: a line with a pipe followed by a delimiter row starts a table, which
// runs to the next blank line. It errs toward finding one, because a wrong match only
// moves the cursor a few lines after a reload, while a missed table gets rewritten.
function f_findTableRangeInText(doc, position) {
  const f_isBlank = lineNumber => doc.line(lineNumber).text.trim() === "";
  const cursorLine = doc.lineAt(position).number;
  let lastLine = cursorLine;
  while (lastLine < doc.lines && !f_isBlank(lastLine + 1)) lastLine++;
  // The topmost candidate is the header: a body row can look like a delimiter row too.
  let headerLine = null;
  for (let lineNumber = cursorLine; lineNumber >= 1 && !f_isBlank(lineNumber); lineNumber--) {
    const isHeader =
      lineNumber < doc.lines && doc.line(lineNumber).text.includes("|") && f_isDelimiterRowText(doc.line(lineNumber + 1).text);
    if (isHeader) headerLine = lineNumber;
  }
  return headerLine === null ? null : { from: doc.line(headerLine).from, to: doc.line(lastLine).to };
}

// Whether the changes of a transaction reach into [from, to] of the changed document.
function f_changesTouchRange(changes, from, to) {
  let touchesRange = false;
  changes.iterChangedRanges((fromBefore, toBefore, fromAfter, toAfter) => {
    if (fromAfter <= to && toAfter >= from) touchesRange = true;
  });
  return touchesRange;
}

// The end of the run of non-blank lines around `position`. A table never extends past a
// blank line, so a parse that reaches this far covers the whole table around the position.
function f_endOfBlock(doc, position) {
  let line = doc.lineAt(position);
  while (line.number < doc.lines && doc.line(line.number + 1).text.trim() !== "") line = doc.line(line.number + 1);
  return line.to;
}

// Whether the cursor is heading toward the end of the note. A cursor coming from outside
// the table keeps its direction. One that starts inside (a selection reaching into the
// table that is being collapsed, or a cursor left there) goes the way it moves, and when
// it does not move, away from where the selection began.
function f_isMovingForward(table, previousSelection, newHead) {
  const { anchor, head } = previousSelection;
  if (head < table.from) return true;
  if (head > table.to) return false;
  if (newHead !== head) return newHead > head;
  return anchor < table.from;
}

// The nearest position outside the table, continuing in the direction of travel.
// A table that fills the whole note has no outside; the result is then null.
function f_positionPastTable(table, documentLength, isMovingForward) {
  const positionAfter = table.to < documentLength ? table.to + 1 : null;
  const positionBefore = table.from > 0 ? table.from - 1 : null;
  return isMovingForward ? positionAfter ?? positionBefore : positionBefore ?? positionAfter;
}

function f_isLivePreview(state, livePreviewField) {
  return state.field(livePreviewField, false) === true;
}

// Switching a note from Source mode to Live Preview does not move the cursor, so a
// cursor resting inside a table would start out inside the rendered one. Obsidian
// makes the switch with an internal effect whose value is { field, value }.
//
// The switch is recognized by that effect and never by reading transaction.state:
// computing the state runs Obsidian's table widget against the cursor's old place,
// and the widget focuses its cell editor as a side effect before the cursor is moved.
function f_turnsLivePreviewOn(transaction, livePreviewField) {
  return transaction.effects.some(
    effect => effect.value != null && effect.value.field === livePreviewField && effect.value.value === true
  );
}

// The table that would hold the whole selection, or null. A selection that merely spans
// a table, or reaches into it from outside, does not enter the table editor.
// f_findTable(position) returns the { from, to } of the table at `position`, or null.
function f_tableHoldingSelection(selection, doc, f_findTable) {
  if (selection.ranges.length !== 1) return null;
  const { from, to, head } = selection.main;
  if (!doc.lineAt(head).text.includes("|")) return null;
  const table = f_findTable(head);
  return table && from >= table.from && to <= table.to ? table : null;
}

// Decides whether a transaction would leave the cursor inside a rendered table.
// Returns the position to use instead, or null to leave the transaction alone.
//
// Checked in Live Preview: every transaction that moves the cursor, the switch into
// Live Preview, and any other transaction that keeps the document while the cursor
// rests inside a table. That last case is a note that begins with a table: it opens
// with the cursor there, and the table editor acts on it at the next transaction of
// any kind.
//
// Left alone: document changes, selections that merely span a table, a table whose
// cell editor is open, and a cursor that a document change left inside a table (a
// table being typed: moving that cursor would send the next keystroke elsewhere).
//
// f_parsedTree(state, upTo) returns the syntax tree, parsed up to `upTo` where possible.
// f_isCellEditorOpen(state) tells whether the table editor is already in use.
// f_wasCursorLeftByEdit(state) tells whether a document change put the cursor where it is.
function f_tableSkipPosition(transaction, { livePreviewField, f_parsedTree, f_isCellEditorOpen, f_wasCursorLeftByEdit }) {
  if (transaction.docChanged) return null;
  const state = transaction.startState;
  const turnsLivePreviewOn = f_turnsLivePreviewOn(transaction, livePreviewField);
  if (!f_isLivePreview(state, livePreviewField) && !turnsLivePreviewOn) return null;
  const movesCursor = Boolean(transaction.selection) || turnsLivePreviewOn;
  if (!movesCursor && f_wasCursorLeftByEdit(state)) return null;

  const doc = state.doc;
  const selection = transaction.newSelection;
  const f_findTable = position => {
    // The cursor's own line is classified first, so that a long block of text with
    // pipes that is not a table costs one line of parsing and not the whole block.
    const line = doc.lineAt(position);
    if (!f_isTableRowLine(f_parsedTree(state, line.to), line)) return null;
    return f_findTableRange(f_parsedTree(state, f_endOfBlock(doc, position)), doc, position);
  };
  const table = f_tableHoldingSelection(selection, doc, f_findTable);
  if (!table || f_isCellEditorOpen(state)) return null;
  return f_positionPastTable(table, doc.length, f_isMovingForward(table, state.selection.main, selection.main.head));
}

// Decides whether the reload of a note changed on disk would leave the cursor inside a
// table. Returns the position to use instead, in the reloaded text, or null.
//
// Obsidian reloads such a note as one replacement, from the first line that differs to
// the last. A cursor inside that stretch ends up at its start, which can be a table row,
// and the table editor then opens on it while the note has the focus. Scripts and agents
// that rewrite an open note cause exactly this.
//
// The reloaded text has no syntax tree yet, and the new state must not be asked for one
// (see f_turnsLivePreviewOn), so the table is told from the text. Only a table that the
// reload itself changed is considered: Obsidian also uses this user event when a property
// is edited or another pane changes the note, which leaves the cursor where it was.
function f_reloadSkipPosition(transaction, { livePreviewField, f_isCellEditorOpen }) {
  if (!transaction.docChanged || !transaction.isUserEvent(RELOAD_USER_EVENT)) return null;
  const state = transaction.startState;
  if (!f_isLivePreview(state, livePreviewField)) return null;
  const doc = transaction.newDoc;
  const table = f_tableHoldingSelection(transaction.newSelection, doc, position => f_findTableRangeInText(doc, position));
  if (!table || !f_changesTouchRange(transaction.changes, table.from, table.to)) return null;
  if (f_isCellEditorOpen(state)) return null;
  return f_positionPastTable(table, doc.length, false);
}

// Whether a table cell editor is open in this editor. Obsidian removes the cell editor
// from the page when it closes it. While one is open the guard stays out of the way,
// also when the focus is elsewhere (in the command palette, for example).
function f_hasOpenCellEditor(editorView) {
  return Boolean(editorView && editorView.dom && editorView.dom.querySelector(CELL_EDITOR_SELECTOR));
}

// Whether the keyboard focus is in a table cell editor of this editor.
// Duck-typed on purpose: `instanceof Element` fails in popout windows.
function f_isCellEditorFocused(editorView) {
  if (!editorView || !editorView.dom) return false;
  const focusedElement = editorView.dom.ownerDocument.activeElement;
  return (
    Boolean(focusedElement) &&
    typeof focusedElement.closest === "function" &&
    editorView.dom.contains(focusedElement) &&
    Boolean(focusedElement.closest(CELL_EDITOR_SELECTOR))
  );
}

// Duck-typed on purpose: `instanceof Element` fails for events from popout windows.
function f_isEventInside(event, selector) {
  const target = event.target;
  return Boolean(target) && typeof target.closest === "function" && Boolean(target.closest(selector));
}

// Returns true when the press was stopped together with its default action.
function f_blockTablePointerEvent(event) {
  if (!f_isEventInside(event, RENDERED_TABLE_SELECTOR)) return false;
  // A cell editor that is already open stays usable with the mouse.
  if (f_isEventInside(event, CELL_EDITOR_SELECTOR)) return false;
  event.stopPropagation();
  // Links and controls keep their default action. Elsewhere the default would start
  // a text selection inside the table, which also enters the table editor.
  if (event.target.closest(PRESS_DEFAULT_KEPT_SELECTOR)) return false;
  event.preventDefault();
  return true;
}

// A drag that enters a cell makes the table editor open that cell for the drop.
function f_blockTableDragEvent(event) {
  if (!f_isEventInside(event, RENDERED_TABLE_SELECTOR)) return;
  if (f_isEventInside(event, CELL_EDITOR_SELECTOR)) return;
  event.stopPropagation();
  // Cancelled and marked "none", so the browser neither drops here nor falls back to
  // its own handling of a dropped file.
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "none";
}

function f_blockTableButtonEvent(event) {
  if (!f_isEventInside(event, TABLE_EDITOR_BUTTON_SELECTOR)) return;
  event.stopPropagation();
  event.preventDefault();
}

// Returns the CodeMirror extension. The CodeMirror and Obsidian pieces are passed
// in because Obsidian provides them at runtime; tests pass stand-ins.
// livePreviewField and editorViewField are Obsidian's editorLivePreviewField and
// editorEditorField.
function f_buildLivePreviewTableGuard({
  EditorState,
  EditorView,
  StateField,
  ViewPlugin,
  syntaxTree,
  ensureSyntaxTree,
  livePreviewField,
  editorViewField,
}) {
  // True while the cursor is where a document change left it, false once it was moved
  // or while it is where the note opened with it.
  const cursorLeftByEditField = StateField.define({
    create: () => false,
    update: (wasLeftByEdit, transaction) => (transaction.docChanged ? true : transaction.selection ? false : wasLeftByEdit),
  });
  const cursorRules = {
    livePreviewField,
    f_parsedTree: (state, upTo) => ensureSyntaxTree(state, upTo, PARSE_BUDGET_MILLISECONDS) ?? syntaxTree(state),
    f_isCellEditorOpen: state => f_hasOpenCellEditor(state.field(editorViewField, false)),
    f_wasCursorLeftByEdit: state => state.field(cursorLeftByEditField, false) === true,
  };
  const cursorGuard = EditorState.transactionFilter.of(transaction => {
    const position = f_tableSkipPosition(transaction, cursorRules);
    if (position !== null) return [transaction, { selection: { anchor: position } }];
    const positionAfterReload = f_reloadSkipPosition(transaction, cursorRules);
    // `sequential` makes the position refer to the reloaded text.
    if (positionAfterReload !== null) return [transaction, { selection: { anchor: positionAfterReload }, sequential: true }];
    return transaction;
  });
  // Capture-phase listeners on each editor element, so popout windows are covered.
  const inputGuard = ViewPlugin.fromClass(class {
    constructor(view) {
      this.editorElement = view.dom;
      // Stopping a press also stops the browser from moving the keyboard focus. Without
      // this, a click on a table in another pane would make that pane the active one
      // while typing still went to the pane left behind.
      const f_blockPressAndKeepFocus = event => {
        if (!f_blockTablePointerEvent(event)) return;
        // Not for touch or pen: a scroll that starts on a table must not bring up the
        // on-screen keyboard. Mouse events carry no pointer type.
        const isMousePress = event.pointerType === undefined || event.pointerType === "mouse";
        // An open cell editor has the focus instead of the note; taking it would close it.
        if (isMousePress && !view.hasFocus && !f_isCellEditorFocused(view)) view.focus();
      };
      // Listeners are created per guard instance: one shared between two instances on
      // the same editor would be registered once and removed by whichever ends first.
      this.listeners = [
        ...BLOCKED_POINTER_EVENT_TYPES.map(type => ({ type, f_listener: f_blockPressAndKeepFocus })),
        ...BLOCKED_BUTTON_EVENT_TYPES.map(type => ({ type, f_listener: event => f_blockTableButtonEvent(event) })),
        ...BLOCKED_DRAG_EVENT_TYPES.map(type => ({ type, f_listener: event => f_blockTableDragEvent(event) })),
      ];
      for (const { type, f_listener } of this.listeners) this.editorElement.addEventListener(type, f_listener, true);
    }

    destroy() {
      for (const { type, f_listener } of this.listeners) this.editorElement.removeEventListener(type, f_listener, true);
    }
  });
  return [cursorGuard, inputGuard, EditorView.editorAttributes.of({ class: GUARDED_EDITOR_CLASS }), cursorLeftByEditField];
}

module.exports = {
  BLOCKED_BUTTON_EVENT_TYPES,
  BLOCKED_DRAG_EVENT_TYPES,
  BLOCKED_POINTER_EVENT_TYPES,
  GUARDED_EDITOR_CLASS,
  f_blockTableButtonEvent,
  f_blockTableDragEvent,
  f_blockTablePointerEvent,
  f_buildLivePreviewTableGuard,
  f_endOfBlock,
  f_findTableRange,
  f_findTableRangeInText,
  f_hasOpenCellEditor,
  f_isCellEditorFocused,
  f_isMovingForward,
  f_positionPastTable,
  f_reloadSkipPosition,
  f_tableSkipPosition,
  f_turnsLivePreviewOn,
};
