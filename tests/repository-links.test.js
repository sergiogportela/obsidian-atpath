const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  f_scanMarkdownLinks, f_resolveRepositoryLink, f_originIdentity, f_formatRepositoryLink, f_formatGithubLink
} = require("../src/repository-links");
const fixture = require("./fixtures/repository-links.json");

for (const item of fixture.cases) {
  test(item.name, () => {
    const result = f_resolveRepositoryLink(item.destination, {
      sourcePath: item.sourcePath,
      repositories: fixture.repositories,
      getTargetType: vaultPath => fixture.targets[vaultPath]
    });
    for (const [key, value] of Object.entries(item.expected)) assert.equal(result[key], value, key);
  });
}

for (const item of fixture.markdownCases) {
  test(item.name, () => {
    const links = f_scanMarkdownLinks(item.markdown);
    let previousEnd = 0;
    assert.deepEqual(links.map(link => {
      const { start, end } = link.position;
      assert.ok(start.offset >= previousEnd);
      previousEnd = end.offset;
      for (const position of [start, end]) {
        const lines = item.markdown.slice(0, position.offset).split(/\r\n|\r|\n/);
        assert.equal(position.line, lines.length - 1);
        assert.equal(position.col, lines.at(-1).length);
      }
      return {
        destination: link.destination, label: link.label,
        raw: item.markdown.slice(start.offset, end.offset)
      };
    }), item.expected);
  });
}

test("origin identity supports HTTPS and SSH without relying on checkout names", () => {
  assert.equal(f_originIdentity("https://github.com/Owner/Repo.git"), "owner/repo");
  assert.equal(f_originIdentity("git@github.com:Owner/Repo.git"), "owner/repo");
  assert.equal(f_originIdentity("ssh://git@github.com/Owner/Repo"), "owner/repo");
  assert.equal(f_originIdentity("https://example.com/Owner/Repo.git"), null);
});

test("resolution preserves position and uses the destination regardless of label", () => {
  const [link] = f_scanMarkdownLinks("text [Elsewhere](/AGENTS.md)");
  const result = f_resolveRepositoryLink(link, {
    sourcePath: "projects/one/dir/source.md",
    repositories: fixture.repositories,
    getTargetType: vaultPath => fixture.targets[vaultPath]
  });
  assert.deepEqual(result.position, link.position);
  assert.equal(result.vaultPath, "projects/one/AGENTS.md");
});

test("authoring generates scoped destinations and full labels and rejects unaddressable checkouts", () => {
  const source = "projects/one/dir/source.md";
  const repos = fixture.repositories;
  assert.equal(f_formatRepositoryLink("projects/one/dir/space (x).md", source, repos, "file"),
    "[dir/space (x).md](/dir/space%20%28x%29.md)");
  assert.equal(f_formatRepositoryLink("third/AGENTS.md", source, repos, "file"),
    "[beta/AGENTS.md](https://github.com/org/beta/blob/main/AGENTS.md)");
  assert.equal(f_formatRepositoryLink("projects/one/docs", source, repos, "folder"),
    "[docs/](/docs/)");
  assert.throws(() => f_formatRepositoryLink("moved/beta-checkout/AGENTS.md", source, repos, "file"),
    /unique GitHub link/);
});

test("authored path labels keep intraword underscores readable without enabling Markdown formatting", () => {
  const MarkdownIt = require("markdown-it");
  const parser = new MarkdownIt();
  const source = "projects/one/source.md";
  for (const label of [
    "21_git_workspace/PRD.md", "MATRIZ_GERAL.md", "ação_última/文件_名称.md", "a__b.md",
    "_private_/file.md", "a_/b_c_.md", "[brackets]*stars*`code`&amp;~strike~.md", "back\\slash.md",
  ]) {
    const markdown = f_formatRepositoryLink("projects/one/" + label, source, fixture.repositories, "file");
    const [link] = f_scanMarkdownLinks(markdown);
    assert.equal(link.label, label);
    const children = parser.parseInline(markdown, {})[0].children;
    assert.deepEqual(children.map(child => child.type), ["link_open", "text", "link_close"], label);
    assert.equal(children[1].content, label);
    if (["21_git_workspace/PRD.md", "MATRIZ_GERAL.md", "ação_última/文件_名称.md", "a__b.md"].includes(label)) {
      assert.ok(markdown.startsWith("[" + label + "]("), markdown);
    }
  }
});

test("a canonical GitHub identity outranks aliases on other checkouts", () => {
  const sourcePath = "projects/one/dir/source.md";
  const repositories = fixture.repositories.map(repo =>
    repo.identity === "org/alpha" ? { ...repo, aliases: [...repo.aliases, "org/beta"] } : repo
  );
  const markdown = f_formatRepositoryLink("third/AGENTS.md", sourcePath, repositories, "file");
  const [link] = f_scanMarkdownLinks(markdown);
  const result = f_resolveRepositoryLink(link, {
    sourcePath, repositories, getTargetType: vaultPath => fixture.targets[vaultPath]
  });
  assert.equal(result.status, "resolved");
  assert.equal(result.repository, "org/beta");
  assert.equal(result.vaultPath, "third/AGENTS.md");
});

test("GitHub links name the repository and resolve back to the same local target", () => {
  const repos = fixture.repositories;
  const cases = [
    ["projects/one/dir/space (x).md", "file", "[alpha/dir/space (x).md](https://github.com/org/alpha/blob/main/dir/space%20%28x%29.md)"],
    ["projects/one/docs", "folder", "[alpha/docs/](https://github.com/org/alpha/tree/main/docs/)"],
    ["projects/one", "folder", "[alpha/](https://github.com/org/alpha/tree/main/)"],
    ["third/AGENTS.md", "file", "[beta/AGENTS.md](https://github.com/org/beta/blob/main/AGENTS.md)"],
    ["README.md", "file", "[workspace/README.md](https://github.com/org/workspace/blob/main/README.md)"],
    ["", "folder", "[workspace/](https://github.com/org/workspace/tree/main/)"],
    ["projects/one/21_git_workspace/MATRIZ_GERAL.md", "file",
      "[alpha/21_git_workspace/MATRIZ_GERAL.md](https://github.com/org/alpha/blob/main/21_git_workspace/MATRIZ_GERAL.md)"],
  ];
  for (const [vaultPath, kind, expected] of cases) {
    const markdown = f_formatGithubLink(vaultPath, repos, kind);
    assert.equal(markdown, expected);
    // Read from a note in an unrelated checkout, the link must lead to the same target.
    const [link] = f_scanMarkdownLinks(markdown);
    const result = f_resolveRepositoryLink(link, {
      sourcePath: "third/notes.md", repositories: repos, getTargetType: () => kind,
    });
    assert.equal(result.status, "resolved", vaultPath);
    assert.equal(result.vaultPath, vaultPath, vaultPath);
  }
});

test("GitHub links stay available for duplicate checkouts and reject targets without a GitHub origin", () => {
  const repos = fixture.repositories;
  // Two local checkouts of one GitHub repository share the same public address.
  assert.equal(f_formatGithubLink("moved/beta-checkout/AGENTS.md", repos, "file"),
    "[beta/AGENTS.md](https://github.com/other/beta/blob/main/AGENTS.md)");
  assert.equal(f_formatGithubLink("clones/beta/AGENTS.md", repos, "file"),
    "[beta/AGENTS.md](https://github.com/other/beta/blob/main/AGENTS.md)");
  // A nested checkout without a GitHub origin must not borrow its parent's address.
  assert.throws(() => f_formatGithubLink("projects/one/nested/file.md", repos, "file"), /unique GitHub link/);
  assert.throws(() => f_formatGithubLink("notes/file.md", [], "file"), /Repository map is unavailable/);
});
