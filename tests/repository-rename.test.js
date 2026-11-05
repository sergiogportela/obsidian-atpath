"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { f_rewriteRepositoryDestinations, f_scanMarkdownLinks } = require("../src/repository-links");

const repositories = [
  { root: "a", identity: "owner/first", refs: ["feature/topic"] },
  { root: "b", identity: "owner/second" },
];

function f_rewrite(markdown, sourcePath, oldPath, newPath, files) {
  return f_rewriteRepositoryDestinations(markdown, {
    sourcePath, moves: [{ oldPath, newPath }], repositories,
    getTargetType: path => files[path] ?? null,
  });
}

test("rename updates only an inline destination and keeps escapes, labels, titles and suffixes", () => {
  const input = '[The **authored** label](  </Old \\(copy\\).md?view=1&amp;mode=2&#35;Heading> "Title")\r\n'
    + '[ordinary](./Old%20%28copy%29.md) `[code](/Old%20%28copy%29.md)`';
  assert.equal(f_rewrite(input, "a/note.md", "a/Old (copy).md", "a/New copy.md", { "a/New copy.md": "file" }),
    input.replace('/Old \\(copy\\).md?', '/New%20copy.md?'));
});

test("rename rewrites the shared reference definition once and keeps multiline container syntax", () => {
  const input = "[First][Shared] [Shared][] [Shared]\r\n\r\n"
    + "> [Shared]:\r\n>   </Old name.md> 'Keep this title'\r\n"
    + "\r\n```markdown\r\n[Fake]: /Old%20name.md\r\n```";
  assert.equal(f_rewrite(input, "a/note.md", "a/Old name.md", "a/New name.md", { "a/New name.md": "file" }),
    input.replace("</Old name.md>", "</New%20name.md>"));
});

test("rename keeps a GitHub autolink, non-main ref and historical SHA intact", () => {
  const input = "<https://github.com/Owner/First/blob/feature/topic/old.md#L2>\n"
    + '[Pinned](https://github.com/Owner/First/blob/123abcd/old.md "Do not change")\n'
    + '[Named](https://github.com/Owner/First/blob/feature%2Ftopic/old.md "Keep title")';
  const expected = input.replaceAll("/old.md#", "/new.md#")
    .replace("/feature%2Ftopic/old.md", "/feature%2Ftopic/new.md");
  assert.equal(f_rewrite(input, "a/note.md", "a/old.md", "a/new.md", { "a/new.md": "file" }), expected);
});

test("moving the source to a different checkout changes repository-root links without altering existing URLs", () => {
  const input = "[Keep label](/context.md 'Title')\n"
    + "<https://github.com/owner/first/blob/feature/topic/context.md>";
  assert.equal(f_rewrite(input, "b/note.md", "a/note.md", "b/note.md", { "a/context.md": "file" }),
    input.replace("(/context.md", "(https://github.com/owner/first/blob/main/context.md"));
});

test("moving a linked target across repositories keeps the non-main ref and applies the new identity", () => {
  const input = "[Keep label](/old.md)\n"
    + "<https://github.com/Owner/First/blob/feature/topic/old.md?view=1#L2>";
  assert.equal(f_rewrite(input, "a/note.md", "a/old.md", "b/new.md", { "b/new.md": "file" }),
    "[Keep label](https://github.com/owner/second/blob/main/new.md)\n"
    + "<https://github.com/owner/second/blob/feature%2Ftopic/new.md?view=1#L2>");
});

test("nested image labels never supply the parent link's destination range", () => {
  const input = [
    "[![alt](/img.png)](/old.md)",
    "[**![alt](/img.png)** and `code`](</old.md> 'Title')",
    "[![alt](/img.png)][ref]",
    "",
    "[ref]: /old.md",
  ].join("\n");
  const links = f_scanMarkdownLinks(input, { destinationRanges: true });
  assert.equal(links.length, 4);
  assert.equal(links[2].destinationRange, undefined);
  for (const { destination, destinationRange } of links.filter(link => link.destinationRange)) {
    assert.equal(input.slice(destinationRange.start, destinationRange.end), destination);
  }
  assert.equal(f_rewrite(input, "a/note.md", "a/old.md", "a/new.md", {
    "a/new.md": "file",
    "a/img.png": "file",
  }), input.replaceAll("/old.md", "/new.md"));
  assert.equal(f_rewrite(input, "a/note.md", "a/img.png", "a/renamed.png", {
    "a/old.md": "file",
    "a/renamed.png": "file",
  }), input);
});

test("a batch rewrites independent encoded destinations, definitions and autolinks together", () => {
  const input = '[First](/Old%20one.md "Title") [Second][shared]\n\n'
    + '[shared]: </Old two.md?view=1&amp;mode=2#Heading>\n'
    + '<https://github.com/Owner/First/blob/feature%2Ftopic/old-three.md#L2>\n'
    + '[Pinned](https://github.com/Owner/First/blob/123abcd/Old%20one.md)';
  const output = f_rewriteRepositoryDestinations(input, {
    sourcePath: "a/note.md", repositories,
    moves: [
      { oldPath: "a/Old one.md", newPath: "a/New one.md" },
      { oldPath: "a/Old two.md", newPath: "a/New two.md" },
      { oldPath: "a/old-three.md", newPath: "a/new-three.md" },
    ],
    getTargetType: path => ["a/New one.md", "a/New two.md", "a/new-three.md"].includes(path) ? "file" : null,
  });
  assert.equal(output, input.replace('(/Old%20one.md', '(/New%20one.md')
    .replace('</Old two.md?', '</New%20two.md?').replace('/old-three.md#', '/new-three.md#'));
});

test("chained moves and temporary-path swaps retain the original target identities", () => {
  const moves = [
    { oldPath: "a/first.md", newPath: "a/temporary.md" },
    { oldPath: "a/second.md", newPath: "a/first.md" },
    { oldPath: "a/temporary.md", newPath: "a/second.md" },
  ];
  assert.equal(f_rewriteRepositoryDestinations('[A](/first.md) [B](/second.md)', {
    sourcePath: "a/second.md", repositories, moves,
    getTargetType: path => ["a/first.md", "a/second.md"].includes(path) ? "file" : null,
  }), '[A](/second.md) [B](/first.md)');
});

test("moving a folder, its source and a linked target across checkouts formats final paths once", () => {
  const input = '[Local](/docs/other.md) [Keep](/outside.md)';
  assert.equal(f_rewriteRepositoryDestinations(input, {
    sourcePath: "b/renamed/note.md", repositories,
    moves: [
      { oldPath: "a/docs", newPath: "b/docs" },
      { oldPath: "b/docs", newPath: "b/renamed" },
      { oldPath: "b/renamed/other.md", newPath: "b/renamed/new.md" },
    ],
    getTargetType: path => ["b/renamed/new.md", "a/outside.md"].includes(path) ? "file" : null,
  }), '[Local](/renamed/new.md) [Keep](https://github.com/owner/first/blob/main/outside.md)');
});

test("checkout-root moves use before and after maps without changing GitHub identity or refs", () => {
  const input = '[Local](/old.md) <https://github.com/Owner/First/blob/feature/topic/old.md>';
  assert.equal(f_rewriteRepositoryDestinations(input, {
    sourcePath: "renamed/note.md", repositoriesBefore: repositories,
    repositories: [{ ...repositories[0], root: "renamed" }, repositories[1]],
    moves: [{ oldPath: "a", newPath: "renamed" }, { oldPath: "renamed/old.md", newPath: "renamed/new.md" }],
    getTargetType: path => path === "renamed/new.md" ? "file" : null,
  }), '[Local](/new.md) <https://github.com/Owner/First/blob/feature/topic/new.md>');
});
