"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const {
  BLOCKED_BUTTON_EVENT_TYPES, BLOCKED_DRAG_EVENT_TYPES, BLOCKED_POINTER_EVENT_TYPES, GUARDED_EDITOR_CLASS,
  f_blockTableButtonEvent, f_blockTableDragEvent, f_blockTablePointerEvent, f_buildLivePreviewTableGuard, f_endOfBlock,
  f_findTableRange, f_findTableRangeInText, f_hasOpenCellEditor, f_isCellEditorFocused, f_isMovingForward,
  f_positionPastTable, f_reloadSkipPosition, f_tableSkipPosition, f_turnsLivePreviewOn,
} = require("../src/live-preview-table-guard");

// Stand-ins for a CodeMirror document and for Obsidian's syntax tree, which
// names every table line with a node that starts at the line start.
function f_document(text) {
  const lines = [];
  let offset = 0;
  for (const [index, lineText] of text.split("\n").entries()) {
    lines.push({ number: index + 1, from: offset, to: offset + lineText.length, text: lineText });
    offset += lineText.length + 1;
  }
  return {
    length: text.length,
    lines: lines.length,
    line: number => lines[number - 1],
    lineAt: position => lines.find(line => position >= line.from && position <= line.to),
  };
}

function f_syntaxTreeOf(doc) {
  const nodes = [];
  for (let number = 1; number <= doc.lines; number++) {
    const line = doc.line(number);
    if (line.text.startsWith("|")) {
      nodes.push({ from: line.from, to: line.to, type: { name: "HyperMD-table-2_HyperMD-table-row_HyperMD-table-row-0" } });
      nodes.push({ from: line.from + 2, to: line.to, type: { name: "hmd-table-sep" } });
    } else if (line.text) {
      nodes.push({ from: line.from, to: line.to, type: { name: "paragraph" } });
    }
  }
  return { iterate: ({ from, to, enter }) => {
    for (const node of nodes) if (node.from <= to && node.to >= from && enter(node) === false) return;
  } };
}

const NOTE = ["Intro", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "", "Outro | with a pipe"].join("\n");
const DOC = f_document(NOTE);
const TABLE = { from: DOC.line(3).from, to: DOC.line(5).to };

// Stand-ins for Obsidian's editorLivePreviewField and editorEditorField; states answer
// for these two and nothing else.
const LIVE_PREVIEW_FIELD = { name: "live preview" };
const EDITOR_VIEW_FIELD = { name: "editor view" };

function f_transaction({
  head, anchor = head, previousHead, previousAnchor = previousHead, docChanged = false, hasSelection = true,
  extraRanges = 0, doc = DOC, livePreview = true, editorView = null, userEvent = null, newDoc = doc,
  cursorLeftByEdit = false, changedRange = [0, newDoc.length],
}) {
  const main = { from: Math.min(anchor, head), to: Math.max(anchor, head), head };
  const fieldValues = new Map([[LIVE_PREVIEW_FIELD, livePreview], [EDITOR_VIEW_FIELD, editorView]]);
  // The guard's own field is the only one a state is asked for besides Obsidian's two.
  const f_isGuardField = field => typeof field.create === "function" && typeof field.update === "function";
  const f_fieldValue = field => (f_isGuardField(field) ? cursorLeftByEdit : fieldValues.get(field));
  const transaction = {
    docChanged,
    effects: [],
    isUserEvent: event => event === userEvent,
    newDoc,
    // One changed stretch, given by where it lies in the changed document.
    changes: { iterChangedRanges: f_visit => f_visit(changedRange[0], changedRange[1], changedRange[0], changedRange[1]) },
    selection: hasSelection ? {} : undefined,
    newSelection: { main, ranges: [main, ...Array(extraRanges).fill(main)] },
    startState: {
      doc,
      selection: { main: { anchor: previousAnchor, head: previousHead } },
      field: (field, isRequired) =>
        ((fieldValues.has(field) || f_isGuardField(field)) && isRequired === false ? f_fieldValue(field) : assert.fail("unexpected field")),
    },
  };
  // Computing the resulting state lets Obsidian's table widget focus a cell; the guard must never ask for it.
  return Object.defineProperty(transaction, "state", { get: () => assert.fail("transaction.state was read") });
}

// What Obsidian dispatches when a note changes editing mode: effects only, cursor untouched.
// The first effect stands for the compartment change that travels with it.
function f_modeSwitch({ head, fromLivePreview, toLivePreview }) {
  const transaction = f_transaction({ head, previousHead: head, hasSelection: false, livePreview: fromLivePreview });
  transaction.effects = [{ value: { compartment: {}, extension: [] } }, { value: { field: LIVE_PREVIEW_FIELD, value: toLivePreview } }];
  return transaction;
}

// A cursor that stays where it was, in a transaction that carries no selection.
function f_restingCursor({ head, doc = DOC }) {
  return f_transaction({ head, previousHead: head, hasSelection: false, doc });
}

const f_treeOfState = state => f_syntaxTreeOf(state.doc);
const f_skip = (transaction, { isCellEditorOpen = false, wasCursorLeftByEdit = false } = {}) => f_tableSkipPosition(transaction, {
  livePreviewField: LIVE_PREVIEW_FIELD,
  f_parsedTree: f_treeOfState,
  f_isCellEditorOpen: () => isCellEditorOpen,
  f_wasCursorLeftByEdit: () => wasCursorLeftByEdit,
});

test("a table is found from any of its lines and only from them", () => {
  const tree = f_syntaxTreeOf(DOC);
  for (const line of [3, 4, 5]) {
    assert.deepEqual(f_findTableRange(tree, DOC, DOC.line(line).from), TABLE);
    assert.deepEqual(f_findTableRange(tree, DOC, DOC.line(line).to), TABLE);
  }
  for (const line of [1, 2, 6, 7]) assert.equal(f_findTableRange(tree, DOC, DOC.line(line).from), null);
});

test("a table that starts or ends the note has no row beyond the note", () => {
  const doc = f_document("| a |\n| --- |\n| 1 |");
  assert.deepEqual(f_findTableRange(f_syntaxTreeOf(doc), doc, 0), { from: 0, to: doc.length });
});

test("the cursor continues past the table in its direction of travel", () => {
  assert.equal(f_positionPastTable(TABLE, DOC.length, true), TABLE.to + 1);
  assert.equal(f_positionPastTable(TABLE, DOC.length, false), TABLE.from - 1);
});

test("a table at the edge of the note sends the cursor back to the only side there is", () => {
  assert.equal(f_positionPastTable({ from: 10, to: 30 }, 30, true), 9);
  assert.equal(f_positionPastTable({ from: 0, to: 30 }, 50, false), 31);
  assert.equal(f_positionPastTable({ from: 0, to: 30 }, 30, true), null);
});

test("the direction of travel comes from where the cursor was, then from how it moves", () => {
  const inside = TABLE.from + 4;
  assert.equal(f_isMovingForward(TABLE, { anchor: 0, head: 0 }, inside), true, "from above");
  assert.equal(f_isMovingForward(TABLE, { anchor: DOC.length, head: DOC.length }, inside), false, "from below");
  assert.equal(f_isMovingForward(TABLE, { anchor: 0, head: inside }, inside + 3), true, "inside, moving down");
  assert.equal(f_isMovingForward(TABLE, { anchor: 0, head: inside }, inside - 3), false, "inside, moving up");
  assert.equal(f_isMovingForward(TABLE, { anchor: 0, head: inside }, inside), true, "still, selection began above");
  assert.equal(f_isMovingForward(TABLE, { anchor: DOC.length, head: inside }, inside), false, "still, selection began below");
  assert.equal(f_isMovingForward(TABLE, { anchor: inside, head: inside }, inside), false, "still, with nothing to go by");
});

test("a block ends at the last line before a blank one or at the end of the note", () => {
  assert.equal(f_endOfBlock(DOC, TABLE.from), TABLE.to);
  assert.equal(f_endOfBlock(DOC, TABLE.to), TABLE.to);
  assert.equal(f_endOfBlock(DOC, 0), DOC.line(1).to);
  assert.equal(f_endOfBlock(DOC, DOC.length), DOC.length);
  const spaced = f_document("| a |\n| --- |\n   \n| b |");
  assert.equal(f_endOfBlock(spaced, 0), spaced.line(2).to, "a line of spaces is blank");
});

test("moving the cursor into a table from above or below lands on the far side", () => {
  assert.equal(f_skip(f_transaction({ head: TABLE.from + 2, previousHead: 0 })), TABLE.to + 1);
  assert.equal(f_skip(f_transaction({ head: TABLE.to, previousHead: DOC.length })), TABLE.from - 1);
});

test("a selection made entirely inside a table is redirected like a cursor", () => {
  assert.equal(f_skip(f_transaction({ anchor: TABLE.from + 2, head: TABLE.from + 5, previousHead: 0 })), TABLE.to + 1);
});

// Shift+ArrowDown from above leaves the selection's moving end inside the table. The
// next plain arrow key collapses the selection there, which entered the table before 1.11.0 shipped.
test("collapsing a selection that reaches into a table does not enter it", () => {
  const inside = TABLE.from + 4;
  const f_collapse = (previousAnchor, head) => f_skip(f_transaction({ head, previousAnchor, previousHead: inside }));
  assert.equal(f_collapse(0, inside + 3), TABLE.to + 1, "selected downward, ArrowDown");
  assert.equal(f_collapse(0, inside), TABLE.to + 1, "selected downward, ArrowRight");
  assert.equal(f_collapse(0, inside - 3), TABLE.from - 1, "selected downward, ArrowUp");
  assert.equal(f_collapse(DOC.length, inside), TABLE.from - 1, "selected upward, ArrowLeft");
});

// A note that begins with a table opens with the cursor at its start. The table editor
// acts on such a cursor at the next transaction, whatever it carries.
test("a cursor a note opens with inside a table is moved out by the next transaction of any kind", () => {
  const doc = f_document("| a |\n| --- |\n| 1 |\n\nText");
  assert.equal(f_skip(f_restingCursor({ head: 0, doc })), doc.line(3).to + 1, "a table on the first line has no line above");
  assert.equal(f_skip(f_restingCursor({ head: TABLE.from + 2 })), TABLE.from - 1);
});

// While a table is being typed, the cursor rests at its end between keystrokes. Moving
// it would send the next keystroke above the table.
test("a cursor that a document change left inside a table stays until it is moved", () => {
  const typing = { wasCursorLeftByEdit: true };
  assert.equal(f_skip(f_restingCursor({ head: TABLE.to }), typing), null);
  assert.equal(f_skip(f_transaction({ head: TABLE.from + 2, previousHead: TABLE.to }), typing), TABLE.from - 1, "an arrow key moves it");
  assert.equal(f_skip(f_modeSwitch({ head: TABLE.to, fromLivePreview: false, toLivePreview: true }), typing), TABLE.from - 1);
});

test("a table whose cell editor is open is left alone", () => {
  const inside = TABLE.from + 2;
  assert.equal(f_skip(f_transaction({ head: inside, previousHead: TABLE.to }), { isCellEditorOpen: true }), null);
  assert.equal(f_skip(f_restingCursor({ head: inside }), { isCellEditorOpen: true }), null);
});

test("transactions the guard must not touch are left alone", () => {
  const inside = TABLE.from + 2;
  const untouched = {
    "a document change such as typing or pasting a table": f_transaction({ head: inside, previousHead: 0, docChanged: true }),
    "several cursors": f_transaction({ head: inside, previousHead: 0, extraRanges: 1 }),
    "a selection that starts above the table": f_transaction({ anchor: 0, head: inside, previousHead: 0 }),
    "a selection that ends below the table": f_transaction({ anchor: DOC.length, head: inside, previousHead: DOC.length }),
    "a cursor on a line outside any table": f_transaction({ head: 2, previousHead: 0 }),
    "a cursor resting outside any table": f_restingCursor({ head: 2 }),
    "a line with a pipe that is not a table": f_transaction({ head: DOC.length, previousHead: 0 }),
  };
  for (const [reason, transaction] of Object.entries(untouched)) assert.equal(f_skip(transaction), null, reason);
});

// CodeMirror parses long notes lazily. The guard asks for a parse that covers the whole
// block around the cursor, so the table's last row is known and not only the row jumped to.
test("the syntax tree is asked to cover the cursor's line, then the whole block if it is a table row", () => {
  const f_requestsFor = head => {
    const requests = [];
    f_tableSkipPosition(f_transaction({ head, previousHead: 0 }), {
      livePreviewField: LIVE_PREVIEW_FIELD,
      f_parsedTree: (state, upTo) => { requests.push(upTo); return f_syntaxTreeOf(state.doc); },
      f_isCellEditorOpen: () => false,
      f_wasCursorLeftByEdit: () => false,
    });
    return requests;
  };
  assert.deepEqual(f_requestsFor(TABLE.from + 2), [DOC.line(3).to, TABLE.to]);
  assert.deepEqual(f_requestsFor(DOC.length), [DOC.length], "a line with a pipe that is no table row costs one line");
  assert.deepEqual(f_requestsFor(2), [], "a line without a pipe costs nothing");
});

test("a table is told from its text by a row with a pipe above a delimiter row", () => {
  for (const line of [3, 4, 5]) assert.deepEqual(f_findTableRangeInText(DOC, DOC.line(line).from), TABLE);
  for (const line of [1, 2, 6, 7]) assert.equal(f_findTableRangeInText(DOC, DOC.line(line).from), null);
  const bare = f_document("a | b\n:-- | --:\n1 | 2\n\n| not | a table |\n| just | pipes |\n\n---\n| x |");
  assert.deepEqual(f_findTableRangeInText(bare, 0), { from: 0, to: bare.line(3).to }, "no outer pipes");
  assert.equal(f_findTableRangeInText(bare, bare.line(5).from), null, "pipes without a delimiter row");
  assert.equal(f_findTableRangeInText(bare, bare.length), null, "a rule is not a delimiter row");
  const dashedRow = f_document("| a | b |\n| --- | --- |\n| x | y |\n| --- | --- |\n| 1 | 2 |");
  assert.deepEqual(f_findTableRangeInText(dashedRow, dashedRow.length), { from: 0, to: dashedRow.length }, "a body row of dashes");
});

// The reloaded note: a table row and the paragraph under the table were rewritten from
// outside, with the cursor in that paragraph. Obsidian leaves the cursor at the start of
// the rewritten stretch, on the table row.
function f_reload({ head, userEvent = "set", livePreview = true, editorView = null, changedRange = [DOC.line(5).from, DOC.length] }) {
  return f_transaction({
    head, previousHead: DOC.length, docChanged: true, hasSelection: false, userEvent, livePreview, editorView, changedRange,
  });
}

const f_reloadSkip = (transaction, { isCellEditorOpen = false } = {}) => f_reloadSkipPosition(transaction, {
  livePreviewField: LIVE_PREVIEW_FIELD,
  f_isCellEditorOpen: () => isCellEditorOpen,
});

test("a reload that leaves the cursor on a table row moves it to the line above the table", () => {
  assert.equal(f_reloadSkip(f_reload({ head: DOC.line(5).from })), TABLE.from - 1);
  assert.equal(f_reloadSkip(f_reload({ head: DOC.line(1).from })), null, "a cursor left outside any table stays");
});

test("only the reload of a note in Live Preview is treated this way", () => {
  const onTableRow = DOC.line(5).from;
  assert.equal(f_reloadSkip(f_reload({ head: onTableRow, userEvent: "input.type" })), null, "typing a table");
  assert.equal(f_reloadSkip(f_reload({ head: onTableRow, userEvent: null })), null, "a change without a user event");
  assert.equal(f_reloadSkip(f_reload({ head: onTableRow, livePreview: false })), null, "Source mode");
  assert.equal(f_reloadSkip(f_reload({ head: onTableRow }), { isCellEditorOpen: true }), null, "a cell being edited");
  assert.equal(f_reloadSkip(f_transaction({ head: onTableRow, previousHead: 0, userEvent: "set" })), null, "no document change");
});

// Obsidian uses the same user event when a property is edited or another pane changes the
// note. The cursor then stays where it was, and must not be moved for resting on text that
// only looks like a table (in a code block, say).
test("a reload that did not change the table around the cursor leaves the cursor alone", () => {
  const onTableRow = DOC.line(5).from;
  assert.equal(f_reloadSkip(f_reload({ head: onTableRow, changedRange: [0, 3] })), null, "a change above the table");
  assert.equal(f_reloadSkip(f_reload({ head: onTableRow, changedRange: [TABLE.to + 2, DOC.length] })), null, "a change below it");
  assert.equal(f_reloadSkip(f_reload({ head: onTableRow, changedRange: [0, TABLE.from] })), TABLE.from - 1, "a change reaching its first row");
});

// A view whose document focus sits in an element inside (or outside) the editor, with or
// without an open cell editor in it.
function f_editorViewWithFocus({ focusedMatches, isInsideEditor = true, hasOpenCellEditor = false }) {
  const focusedElement = focusedMatches && { closest: selector => (focusedMatches.includes(selector) ? {} : null) };
  return { dom: {
    ownerDocument: { activeElement: focusedElement },
    contains: element => isInsideEditor && element === focusedElement,
    querySelector: selector => (hasOpenCellEditor && selector === ".cm-table-widget .cm-editor" ? {} : null),
  } };
}

test("the table editor counts as in use while a cell editor exists in this editor, focused or not", () => {
  assert.equal(f_hasOpenCellEditor(f_editorViewWithFocus({ focusedMatches: [], hasOpenCellEditor: true })), true);
  assert.equal(f_hasOpenCellEditor(f_editorViewWithFocus({ focusedMatches: null, hasOpenCellEditor: true })), true, "focus in a dialog");
  assert.equal(f_hasOpenCellEditor(f_editorViewWithFocus({ focusedMatches: [] })), false);
  assert.equal(f_hasOpenCellEditor(undefined), false, "an editor without Obsidian's view field");
});

test("the focus counts as in a cell editor only inside one that belongs to this editor", () => {
  const cellEditor = [".cm-table-widget .cm-editor"];
  assert.equal(f_isCellEditorFocused(f_editorViewWithFocus({ focusedMatches: cellEditor })), true);
  assert.equal(f_isCellEditorFocused(f_editorViewWithFocus({ focusedMatches: [] })), false, "focus in the note itself");
  assert.equal(f_isCellEditorFocused(f_editorViewWithFocus({ focusedMatches: cellEditor, isInsideEditor: false })), false, "another pane");
  assert.equal(f_isCellEditorFocused(f_editorViewWithFocus({ focusedMatches: null })), false, "nothing focused");
  assert.equal(f_isCellEditorFocused({ dom: { ownerDocument: { activeElement: {} }, contains: () => true } }), false, "no closest()");
  assert.equal(f_isCellEditorFocused(undefined), false, "no editor");
});

test("Source mode keeps the cursor wherever it is put", () => {
  assert.equal(f_skip(f_transaction({ head: TABLE.from + 2, previousHead: 0, livePreview: false })), null);
  assert.equal(f_skip(f_modeSwitch({ head: TABLE.from + 2, fromLivePreview: false, toLivePreview: false })), null);
});

test("switching to Live Preview with the cursor inside a table moves it out", () => {
  assert.equal(f_skip(f_modeSwitch({ head: TABLE.from + 2, fromLivePreview: false, toLivePreview: true })), TABLE.from - 1);
  assert.equal(f_skip(f_modeSwitch({ head: 2, fromLivePreview: false, toLivePreview: true })), null, "a cursor outside any table stays");
});

test("switching to Source mode does not move a cursor that is inside a table", () => {
  const typingInCell = { isCellEditorOpen: true };
  assert.equal(f_skip(f_modeSwitch({ head: TABLE.from + 2, fromLivePreview: true, toLivePreview: false }), typingInCell), null);
  assert.equal(f_skip(f_modeSwitch({ head: 2, fromLivePreview: true, toLivePreview: false })), null);
});

test("only Obsidian's own effect for the Live Preview field counts as switching it on", () => {
  const f_withEffects = effects => ({ effects });
  const f_turnsOn = effects => f_turnsLivePreviewOn(f_withEffects(effects), LIVE_PREVIEW_FIELD);
  assert.equal(f_turnsOn([{ value: { field: LIVE_PREVIEW_FIELD, value: true } }]), true);
  assert.equal(f_turnsOn([{ value: { field: LIVE_PREVIEW_FIELD, value: false } }]), false);
  assert.equal(f_turnsOn([{ value: { field: { name: "another field" }, value: true } }]), false);
  assert.equal(f_turnsOn([{ value: null }, { value: undefined }, { value: true }, { value: "text" }, {}]), false);
  assert.equal(f_turnsOn([]), false);
});

test("Source mode transactions with other effects leave a cursor inside a table alone", () => {
  const transaction = f_transaction({ head: TABLE.from + 2, previousHead: TABLE.from + 2, hasSelection: false, livePreview: false });
  transaction.effects = [{ value: { compartment: {}, extension: [] } }, { value: 3 }];
  assert.equal(f_skip(transaction), null);
});

test("a table that fills the whole note is left alone", () => {
  const doc = f_document("| a |\n| --- |\n| 1 |");
  assert.equal(f_skip(f_transaction({ head: 2, previousHead: 0, doc })), null);
});

// An event whose target sits inside the elements that `matches` names. Selector
// lists are split so that each alternative is matched whole.
function f_eventInside(matches) {
  return { stopped: false, prevented: false,
    target: { closest: selector => (selector.split(", ").some(alternative => matches.includes(alternative)) ? {} : null) },
    stopPropagation() { this.stopped = true; },
    preventDefault() { this.prevented = true; },
  };
}

function f_pointerEvent(matches) {
  const event = f_eventInside(matches);
  const wasBlocked = f_blockTablePointerEvent(event);
  assert.equal(wasBlocked, event.prevented, "the result tells whether the default action was stopped");
  return { stopped: event.stopped, prevented: event.prevented };
}

function f_buttonEvent(matches) {
  const event = f_eventInside(matches);
  f_blockTableButtonEvent(event);
  return { stopped: event.stopped, prevented: event.prevented };
}

test("a press on a rendered table cell never reaches the table editor", () => {
  assert.deepEqual(f_pointerEvent([".cm-table-widget table"]), { stopped: true, prevented: true });
});

test("a press on a link inside a table keeps its default action", () => {
  assert.deepEqual(f_pointerEvent([".cm-table-widget table", "a"]), { stopped: true, prevented: false });
});

test("a press on a control inside a table keeps its default action", () => {
  for (const control of ["button", "input", "select", "textarea", "label", "summary"]) {
    assert.deepEqual(f_pointerEvent([".cm-table-widget table", control]), { stopped: true, prevented: false }, control);
  }
});

function f_dragEvent(matches) {
  const event = { ...f_eventInside(matches), dataTransfer: { dropEffect: "copy" } };
  f_blockTableDragEvent(event);
  return { stopped: event.stopped, prevented: event.prevented, dropEffect: event.dataTransfer.dropEffect };
}

// A drag that enters a cell makes Obsidian open that cell's editor to receive the drop.
test("a table refuses drags and drops", () => {
  assert.deepEqual(f_dragEvent([".cm-table-widget table"]), { stopped: true, prevented: true, dropEffect: "none" });
  const openCell = [".cm-table-widget table", ".cm-table-widget .cm-editor"];
  assert.deepEqual(f_dragEvent(openCell), { stopped: false, prevented: false, dropEffect: "copy" }, "an open cell editor");
  assert.deepEqual(f_dragEvent([]), { stopped: false, prevented: false, dropEffect: "copy" }, "outside any table");
  assert.doesNotThrow(() => f_blockTableDragEvent({ ...f_eventInside([".cm-table-widget table"]), dataTransfer: null }));
});

test("a press inside a cell editor that is already open passes through", () => {
  const openCell = [".cm-table-widget table", ".cm-table-widget .cm-editor"];
  assert.deepEqual(f_pointerEvent(openCell), { stopped: false, prevented: false });
});

test("presses outside rendered tables and on targets without closest() pass through", () => {
  assert.deepEqual(f_pointerEvent([]), { stopped: false, prevented: false });
  for (const target of [null, {}, { closest: "not a function" }]) {
    assert.doesNotThrow(() => f_blockTablePointerEvent({ target, stopPropagation: assert.fail, preventDefault: assert.fail }));
  }
});

test("a click on the table editor's add-row or add-column button never reaches it", () => {
  assert.deepEqual(f_buttonEvent([".cm-table-widget .table-row-btn"]), { stopped: true, prevented: true });
  assert.deepEqual(f_buttonEvent([".cm-table-widget .table-col-btn"]), { stopped: true, prevented: true });
});

test("clicks on table cells, links and other plugins' table buttons pass through", () => {
  assert.deepEqual(f_buttonEvent([".cm-table-widget table", "a"]), { stopped: false, prevented: false });
  assert.deepEqual(f_buttonEvent([".cm-table-widget .mds-lp-table-btn"]), { stopped: false, prevented: false });
  assert.doesNotThrow(() => f_blockTableButtonEvent({ target: null, stopPropagation: assert.fail, preventDefault: assert.fail }));
});

// Obsidian shows these controls with four-class selectors. A guard rule with fewer
// classes loses to them and the buttons stay visible, which happened before 1.11.0 shipped.
test("the rules hiding the table editor's controls outrank Obsidian's own", () => {
  const styles = fs.readFileSync(path.join(__dirname, "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const guardSelectors = styles.split("}").flatMap(rule => rule.split("{")[0].split(","))
    .map(selector => selector.trim())
    .filter(selector => selector.includes(GUARDED_EDITOR_CLASS));
  assert.equal(guardSelectors.length, 5);
  for (const selector of guardSelectors) {
    assert.ok(selector.startsWith(`.markdown-source-view.mod-cm6 .cm-editor.${GUARDED_EDITOR_CLASS} .cm-table-widget `), selector);
  }
});

function f_buildWithStandIns({ parseFinishes = true, ensureSyntaxTreeCalls = [] } = {}) {
  return f_buildLivePreviewTableGuard({
    EditorState: { transactionFilter: { of: filter => filter } },
    StateField: { define: spec => spec },
    EditorView: { editorAttributes: { of: attributes => ({ editorAttributes: attributes }) } },
    ViewPlugin: { fromClass: pluginClass => pluginClass },
    syntaxTree: f_treeOfState,
    ensureSyntaxTree: (state, upTo, budget) => (ensureSyntaxTreeCalls.push({ upTo, budget }), parseFinishes ? f_treeOfState(state) : null),
    livePreviewField: LIVE_PREVIEW_FIELD,
    editorViewField: EDITOR_VIEW_FIELD,
  });
}

test("the cursor guard appends the redirected selection and otherwise returns the transaction itself", () => {
  const [cursorGuard] = f_buildWithStandIns();
  const entering = f_transaction({ head: TABLE.from + 2, previousHead: 0 });
  assert.deepEqual(cursorGuard(entering), [entering, { selection: { anchor: TABLE.to + 1 } }]);
  const elsewhere = f_transaction({ head: 2, previousHead: 0 });
  assert.equal(cursorGuard(elsewhere), elsewhere);
});

test("the cursor guard finishes the parse within a budget and falls back to the tree there is", () => {
  const ensureSyntaxTreeCalls = [];
  const [cursorGuard] = f_buildWithStandIns({ parseFinishes: false, ensureSyntaxTreeCalls });
  const entering = f_transaction({ head: TABLE.from + 2, previousHead: 0 });
  assert.deepEqual(cursorGuard(entering), [entering, { selection: { anchor: TABLE.to + 1 } }]);
  assert.deepEqual(ensureSyntaxTreeCalls.map(call => call.upTo), [DOC.line(3).to, TABLE.to]);
  for (const { budget } of ensureSyntaxTreeCalls) assert.ok(budget > 0 && budget <= 200, "one cursor move must not freeze the editor");
});

test("the cursor guard places the cursor in the reloaded text, not in the text before the reload", () => {
  const [cursorGuard] = f_buildWithStandIns();
  const reload = f_reload({ head: DOC.line(5).from });
  assert.deepEqual(cursorGuard(reload), [reload, { selection: { anchor: TABLE.from - 1 }, sequential: true }]);
  const typing = f_reload({ head: DOC.line(5).from, userEvent: "input.type" });
  assert.equal(cursorGuard(typing), typing);
});

test("the cursor guard leaves a table alone while a cell editor is open in its editor", () => {
  const [cursorGuard] = f_buildWithStandIns();
  const editorView = f_editorViewWithFocus({ focusedMatches: [], hasOpenCellEditor: true });
  const movingInCell = f_transaction({ head: TABLE.from + 2, previousHead: TABLE.from + 4, editorView });
  assert.equal(cursorGuard(movingInCell), movingInCell);
});

test("the cursor guard remembers whether a document change or a cursor move placed the cursor", () => {
  const [cursorGuard, , , cursorLeftByEditField] = f_buildWithStandIns();
  assert.equal(cursorLeftByEditField.create(), false, "a note opens with a cursor nobody placed");
  assert.equal(cursorLeftByEditField.update(false, { docChanged: true }), true);
  assert.equal(cursorLeftByEditField.update(true, { docChanged: false, selection: {} }), false);
  assert.equal(cursorLeftByEditField.update(true, { docChanged: false }), true, "other transactions change nothing");
  const typed = f_transaction({ head: TABLE.to, previousHead: TABLE.to, hasSelection: false, cursorLeftByEdit: true });
  assert.equal(cursorGuard(typed), typed, "a table being typed keeps its cursor");
  const opened = f_transaction({ head: TABLE.to, previousHead: TABLE.to, hasSelection: false });
  assert.deepEqual(cursorGuard(opened), [opened, { selection: { anchor: TABLE.from - 1 } }]);
});

// Mirrors the DOM: adding the same listener twice registers it once.
function f_editorElement({ focusedElement = null } = {}) {
  const listeners = [];
  const f_indexOf = (type, listener, capture) =>
    listeners.findIndex(entry => entry.type === type && entry.listener === listener && entry.capture === capture);
  return {
    listeners,
    ownerDocument: { activeElement: focusedElement },
    contains: element => element === focusedElement,
    addEventListener: (type, listener, capture) => {
      if (f_indexOf(type, listener, capture) < 0) listeners.push({ type, listener, capture });
    },
    removeEventListener: (type, listener, capture) => {
      const index = f_indexOf(type, listener, capture);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
}

const GUARDED_EVENT_TYPES = [...BLOCKED_POINTER_EVENT_TYPES, ...BLOCKED_BUTTON_EVENT_TYPES, ...BLOCKED_DRAG_EVENT_TYPES];

// An editor view that counts the times it is asked to take the keyboard focus.
function f_editorView({ hasFocus = true, focusedElement = null } = {}) {
  return { dom: f_editorElement({ focusedElement }), hasFocus, focusRequests: 0, focus() { this.focusRequests++; } };
}

const f_targetForEventType = type => (type === "click" ? ".cm-table-widget .table-row-btn" : ".cm-table-widget table");

test("the input guard listens in the capture phase and cleans up after itself", () => {
  const [, InputGuard] = f_buildWithStandIns();
  const view = f_editorView();
  const guard = new InputGuard(view);
  assert.deepEqual(view.dom.listeners.map(entry => [entry.type, entry.capture]), GUARDED_EVENT_TYPES.map(type => [type, true]));
  for (const { type, listener } of view.dom.listeners) {
    const event = f_eventInside([f_targetForEventType(type)]);
    listener(event);
    assert.ok(event.stopped, type);
  }
  guard.destroy();
  assert.equal(view.dom.listeners.length, 0);
});

// Stopping a press stops the browser's focus change with it. A click on a table in another
// pane made that pane active while typing still went to the pane left behind.
test("a stopped press on a table gives the keyboard focus to that table's editor", () => {
  const [, InputGuard] = f_buildWithStandIns();
  const f_focusRequestsAfter = ({ hasFocus, matches, types = BLOCKED_POINTER_EVENT_TYPES, pointerType, focusedElement }) => {
    const view = f_editorView({ hasFocus, focusedElement });
    new InputGuard(view);
    for (const { type, listener } of view.dom.listeners) {
      if (types.includes(type)) listener({ ...f_eventInside(matches), pointerType: type === "pointerdown" ? pointerType : undefined });
    }
    return view.focusRequests;
  };
  const cell = [".cm-table-widget table"];
  assert.equal(f_focusRequestsAfter({ hasFocus: false, matches: cell, pointerType: "mouse" }), BLOCKED_POINTER_EVENT_TYPES.length);
  assert.equal(f_focusRequestsAfter({ hasFocus: true, matches: cell, pointerType: "mouse" }), 0, "an editor that has the focus keeps it");
  assert.equal(f_focusRequestsAfter({ hasFocus: false, matches: [...cell, "a"], pointerType: "mouse" }), 0, "a link keeps its default action");
  assert.equal(f_focusRequestsAfter({ hasFocus: false, matches: [], pointerType: "mouse" }), 0, "a press outside any table");
  const button = [".cm-table-widget .table-row-btn"];
  assert.equal(f_focusRequestsAfter({ hasFocus: false, matches: button, types: BLOCKED_BUTTON_EVENT_TYPES }), 0);
  const f_touchRequests = pointerType => f_focusRequestsAfter({ hasFocus: false, matches: cell, pointerType, types: ["pointerdown"] });
  assert.equal(f_touchRequests("touch"), 0, "a scroll that starts on a table must not raise the on-screen keyboard");
  assert.equal(f_touchRequests("pen"), 0);
  // The note does not have the focus while one of its own cell editors has it; taking it would close that editor.
  const focusedCellEditor = { closest: selector => (selector === ".cm-table-widget .cm-editor" ? {} : null) };
  assert.equal(f_focusRequestsAfter({ hasFocus: false, matches: cell, pointerType: "mouse", focusedElement: focusedCellEditor }), 0);
});

test("a guard that ends while another is on the same editor leaves the other one listening", () => {
  const [, InputGuard] = f_buildWithStandIns();
  const dom = f_editorElement();
  const outgoing = new InputGuard({ ...f_editorView(), dom });
  new InputGuard({ ...f_editorView(), dom });
  outgoing.destroy();
  assert.equal(dom.listeners.length, GUARDED_EVENT_TYPES.length);
});

test("the editor is marked through CodeMirror's own attributes, which survive its class rewrites", () => {
  const [, , marker] = f_buildWithStandIns();
  assert.deepEqual(marker, { editorAttributes: { class: GUARDED_EDITOR_CLASS } });
});

// Obsidian hands plugins its own CodeMirror. A second copy bundled into main.js
// would read a different syntax tree facet, find no tables, and the guard would
// do nothing without any error.
test("the build leaves @codemirror/language to Obsidian", () => {
  const repositoryRoot = path.join(__dirname, "..");
  const buildConfig = fs.readFileSync(path.join(repositoryRoot, "esbuild.config.mjs"), "utf8");
  assert.match(buildConfig, /external: \[[^\]]*"@codemirror\/language"/);
  const bundle = fs.readFileSync(path.join(repositoryRoot, "main.js"), "utf8");
  assert.ok(bundle.includes('require("@codemirror/language")'), "main.js must require it at runtime; run npm run build");
});
