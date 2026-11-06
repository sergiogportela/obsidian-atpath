const MarkdownIt = require("markdown-it");

const markdownParser = new MarkdownIt({ html: true });
// Keep the destination as parsed from Markdown. Percent decoding belongs to the resolver.
markdownParser.normalizeLink = value => value;
markdownParser.validateLink = () => true;

let captureDestination;
const parseLinkDestination = markdownParser.helpers.parseLinkDestination;
markdownParser.helpers.parseLinkDestination = (text, start, max) => {
  const result = parseLinkDestination(text, start, max);
  if (captureDestination && result.ok) {
    const angle = text[start] === "<";
    captureDestination({ destination: result.str, start: start + Number(angle), end: result.pos - Number(angle) });
  }
  return result;
};

function f_captureDestination(parse, accepts = () => true) {
  const previous = captureDestination;
  let destination;
  captureDestination = value => { if (accepts()) destination = value; };
  try {
    return { matched: parse(), destination };
  } finally {
    captureDestination = previous;
  }
}

for (const name of ["link", "autolink"]) {
  // markdown-it exposes block line maps, but no inline source offsets.
  const rule = markdownParser.inline.ruler.__rules__.find(entry => entry.name === name).fn;
  markdownParser.inline.ruler.at(name, (state, silent) => {
    const start = state.pos;
    const tokenCount = state.tokens.length;
    const { matched, destination } = state.env.repositoryDefinitions && name === "link" && state.src.charCodeAt(start) === 0x5b
      // The link rule parses its own destination at the original cursor.
      // It moves the cursor before inspecting or tokenizing the label, where
      // nested image rules can also call parseLinkDestination.
      ? f_captureDestination(() => rule(state, silent), () => state.pos === start)
      : { matched: rule(state, silent) };
    if (matched && !silent) {
      const first = state.tokens[tokenCount];
      const token = first.type === "link_open" ? first : state.tokens[tokenCount + 1];
      token.meta = { start, end: state.pos };
      if (state.env.repositoryDefinitions) {
        if (name === "autolink") token.meta.destination = { start: start + 1, end: state.pos - 1 };
        // A failed inline parse can fall back to a shorter reference link.
        else if (destination?.end < state.pos && destination.destination === token.attrGet("href")) {
          token.meta.destination = destination;
        }
      }
    }
    return matched;
  });
}

const { fn: parseReference, alt: referenceAlternatives } = markdownParser.block.ruler.__rules__
  .find(entry => entry.name === "reference");
markdownParser.block.ruler.at("reference", (state, startLine, endLine, silent) => {
  const definitions = state.env.repositoryDefinitions;
  if (!definitions || silent || state.src.charCodeAt(state.bMarks[startLine] + state.tShift[startLine]) !== 0x5b) {
    return parseReference(state, startLine, endLine, silent);
  }
  const { matched, destination } = f_captureDestination(() => parseReference(state, startLine, endLine, silent));
  if (matched && destination) {
    let { start, end } = destination;
    // The reference rule joins continuation lines after stripping container
    // prefixes and indentation. A destination itself occupies one line.
    for (let line = startLine; line < state.line; line++) {
      const prefix = state.bMarks[line] + state.tShift[line];
      const length = state.eMarks[line] - prefix;
      if (start <= length && end <= length) {
        const lineStart = state.src.lastIndexOf("\n", prefix - 1) + 1;
        definitions.push({ destination: destination.destination, line, col: prefix - lineStart + start, length: end - start });
        break;
      }
      start -= length + 1;
      end -= length + 1;
    }
  }
  return matched;
}, { alt: referenceAlternatives });

function f_inlineSourceMap(content, sourceLines, firstLine, tableColumn) {
  let inlineOffset = 0;
  return content.split("\n").map((line, index) => {
    const source = sourceLines[firstLine + index].text.replace(/\0/g, "\uFFFD");
    const removed = [];
    // The table rule removes the escape before a pipe.
    const searchable = tableColumn === null ? source : source.replace(/\\\|/g, (_, offset) => {
      removed.push(offset - removed.length);
      return "|";
    });
    const searchStart = tableColumn ?? 0;
    let sourceColumn = searchable.indexOf(line, searchStart);
    if (sourceColumn < 0) {
      // Block rules can expand leading tabs; link delimiters occur after that indentation.
      const trimmed = line.trimStart();
      const column = searchable.indexOf(trimmed, searchStart);
      if (column >= 0) sourceColumn = column - (line.length - trimmed.length);
    }
    const range = { inlineOffset, sourceColumn, removed };
    inlineOffset += line.length + 1;
    return range;
  });
}

function f_sourcePosition(offset, ranges, sourceLines, firstLine) {
  let index = ranges.length - 1;
  while (ranges[index].inlineOffset > offset) index--;
  const { inlineOffset, sourceColumn, removed } = ranges[index];
  if (sourceColumn < 0) return null;
  const line = firstLine + index;
  const column = sourceColumn + offset - inlineOffset;
  const col = column + removed.filter(escape => escape <= column).length;
  return { line, col, offset: sourceLines[line].offset + col };
}

function f_scanMarkdownLinks(markdown, { destinationRanges = false } = {}) {
  const links = [];
  let offset = 0;
  const sourceLines = markdown.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).map(line => {
    const source = { text: line.replace(/[\r\n]+$/, ""), offset };
    offset += line.length;
    return source;
  });
  // Obsidian indexes YAML properties separately from the Markdown body.
  const closingLine = /^\uFEFF?---[ \t]*$/.test(sourceLines[0].text)
    ? sourceLines.findIndex(({ text }, index) => index > 0 && /^---[ \t]*$/.test(text))
    : -1;
  const bodyStart = closingLine < 0 ? 0 : (sourceLines[closingLine + 1]?.offset ?? markdown.length);
  const body = markdown.slice(0, bodyStart).replace(/[^\r\n]/g, " ") + markdown.slice(bodyStart);
  let tableLine = 0;
  let tableColumn = 0;
  const env = destinationRanges ? { repositoryDefinitions: [] } : {};
  for (const block of markdownParser.parse(body, env)) {
    if (block.type === "tr_open") {
      tableLine = block.map[0];
      tableColumn = 0;
    }
    if (block.type !== "inline") continue;
    const firstLine = block.map ? block.map[0] : tableLine;
    const ranges = f_inlineSourceMap(block.content, sourceLines, firstLine, block.map ? null : tableColumn);
    if (!block.map) tableColumn = ranges[0].sourceColumn + block.content.length;
    for (let index = 0; index < block.children.length; index++) {
      const token = block.children[index];
      if (token.type !== "link_open" || !token.meta) continue;
      const start = f_sourcePosition(token.meta.start, ranges, sourceLines, firstLine);
      const end = f_sourcePosition(token.meta.end, ranges, sourceLines, firstLine);
      if (!start || !end) continue;
      let label = "";
      for (let depth = 1; depth > 0;) {
        const child = block.children[++index];
        if (child.type === "link_open") depth++;
        if (child.type === "link_close") depth--;
        label += child.type.endsWith("break") ? "\n" : child.content;
      }
      const link = { destination: token.attrGet("href"), label, position: { start, end } };
      if (token.meta.destination) {
        const from = f_sourcePosition(token.meta.destination.start, ranges, sourceLines, firstLine);
        const to = f_sourcePosition(token.meta.destination.end, ranges, sourceLines, firstLine);
        if (from && to) link.destinationRange = { start: from.offset, end: to.offset };
      }
      links.push(link);
    }
  }
  for (const { destination, line, col, length } of env.repositoryDefinitions ?? []) {
    const start = sourceLines[line].offset + col;
    links.push({ destination, destinationRange: { start, end: start + length } });
  }
  return links;
}

function f_originIdentity(origin) {
  const match = origin?.trim().match(/^(?:(?:https?|ssh|git):\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/|[^/@]+@github\.com:|github\.com\/)([\w.-]+)\/([\w.-]+)\/?$/i);
  return match ? (match[1] + "/" + match[2].replace(/\.git$/i, "")).toLowerCase() : null;
}

function f_repositoryForPath(vaultPath, repositories) {
  let closest = null;
  for (const repo of repositories) {
    if (typeof repo.root !== "string") continue;
    if (closest && closest.root.length >= repo.root.length) continue;
    if (!repo.root || vaultPath === repo.root || vaultPath.startsWith(repo.root + "/")) closest = repo;
  }
  return closest;
}

function f_repoPath(vaultPath, repo) {
  return repo.root ? vaultPath.slice(repo.root.length + 1) : vaultPath;
}

function f_decodePathSegments(path) {
  return path.split("/").map(part => {
    const decoded = decodeURIComponent(part);
    if (/[\\/\x00-\x1f\x7f]/.test(decoded)) throw new URIError("Invalid character in path");
    return decoded;
  });
}

function f_normalizeRepoPath(parts) {
  const clean = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (!clean.length) throw new URIError("Link escapes its repository");
      clean.pop();
    } else {
      clean.push(part);
    }
  }
  return clean.join("/");
}

function f_githubRefAndPath(raw, refs, kind) {
  const [first, ...rest] = raw.split("/");
  const ref = decodeURIComponent(first);
  if (!ref || /[\\\x00-\x20\x7f]/.test(ref) || ref.split("/").some(part => !part || part === "." || part === "..")) {
    throw new URIError("Invalid GitHub ref");
  }
  const parts = f_decodePathSegments(rest.join("/"));
  if (kind === "file" && !parts.some(Boolean)) throw new URIError("GitHub file path is empty");
  if (ref.includes("/")) return { ref, rawRef: first, parts };
  const tail = [ref, ...parts].join("/");
  const matches = [...new Set(refs || [])].filter(name => tail === name || tail.startsWith(name + "/"));
  if (matches.length > 1) return null;
  if (matches.length === 1) {
    const boundary = matches[0].split("/").length - 1;
    return { ref: matches[0], rawRef: [first, ...rest.slice(0, boundary)].join("/"), parts: parts.slice(boundary) };
  }
  const conventionalRef = /^(?:main|master|HEAD|[\da-f]{7,64})$/i.test(ref);
  const pathSegments = parts.filter(Boolean).length;
  const uniqueBoundary = kind === "folder" ? pathSegments === 0 : pathSegments === 1;
  return conventionalRef || uniqueBoundary ? { ref, rawRef: first, parts } : null;
}

function f_resolveRepositoryLink(link, { sourcePath, repositories, getTargetType }) {
  const { destination, position } = typeof link === "string" ? { destination: link } : link;
  const result = { destination, ...(position && { position }) };
  const fail = (status, reason) => ({ ...result, status, reason });
  const hash = destination.indexOf("#");
  result.fragment = hash < 0 ? "" : destination.slice(hash);
  const path = (hash < 0 ? destination : destination.slice(0, hash)).split("?")[0];
  const github = path.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(blob|tree)\/([^]*?)$/i);
  const sourceRepo = f_repositoryForPath(sourcePath, repositories);
  let repo = sourceRepo;
  let expectedKind = path.endsWith("/") ? "folder" : null;
  let parts;
  try {
    if (github) {
      const identity = github[1].toLowerCase();
      result.repository = identity;
      const canonical = repositories.filter(item => item.identity === identity);
      const matches = canonical.length ? canonical : repositories.filter(item => item.aliases?.includes(identity));
      if (!matches.length) return fail("out-of-scope", "GitHub repository is outside the workspace");
      const checkouts = matches.filter(item => typeof item.root === "string");
      if (checkouts.includes(sourceRepo)) repo = sourceRepo;
      else if (checkouts.length === 1) repo = checkouts[0];
      else if (!checkouts.length) return fail("missing", "Local checkout is unavailable");
      else return fail("ambiguous", "Multiple local checkouts have this GitHub identity");
      expectedKind = github[2].toLowerCase() === "tree" ? "folder" : "file";
      const parsed = f_githubRefAndPath(github[3], repo.refs, expectedKind);
      if (!parsed) return fail("ambiguous", "GitHub ref boundary is ambiguous");
      result.ref = parsed.ref;
      result.rawRef = parsed.rawRef;
      parts = parsed.parts;
      if (expectedKind === "file" && !parts.some(Boolean)) throw new URIError("GitHub file path is empty");
    } else {
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(path)) return fail("out-of-scope", "External link");
      if (!repo) return fail("missing", "Source repository is unavailable");
      const sourceParts = f_repoPath(sourcePath, repo).split("/");
      if (path) {
        const relative = f_decodePathSegments(path);
        parts = path.startsWith("/") ? relative : sourceParts.slice(0, -1).concat(relative);
      } else {
        parts = sourceParts;
      }
    }
    result.repository = repo.identity || null;
    result.repoPath = f_normalizeRepoPath(parts);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
    return fail("invalid", error.message);
  }

  result.vaultPath = [repo.root, result.repoPath].filter(Boolean).join("/");
  // The callback owns physical containment checks when it reads via the filesystem.
  const kind = getTargetType(result.vaultPath);
  if (!kind) return fail("missing", "Local target is unavailable");
  if (expectedKind && expectedKind !== kind) return fail("invalid", "Local target has a different type");
  return { ...result, status: "resolved", kind };
}

function f_repositoryLinkParts(targetPath, sourcePath, repositories, kind, github) {
  const source = f_repositoryForPath(sourcePath, repositories);
  const target = f_repositoryForPath(targetPath, repositories);
  if (!source || !target) throw new Error("Repository map is unavailable for this link");
  const sameCheckout = source.root === target.root;
  if ((github && !target.identity) || (!sameCheckout && (!target.identity || source.identity === target.identity ||
    repositories.filter(repo => typeof repo.root === "string" && repo.identity === target.identity).length !== 1))) {
    throw new Error("Target checkout cannot be addressed by a unique GitHub link");
  }
  const relative = f_repoPath(targetPath, target);
  const encoded = relative.split("/").map(part =>
    encodeURIComponent(part).replace(/[!'()*]/g, char => "%" + char.charCodeAt(0).toString(16).toUpperCase())
  ).join("/");
  const directory = kind === "folder";
  const suffix = directory && relative ? "/" : "";
  const destination = sameCheckout && !github ? "/" + encoded + suffix :
    "https://github.com/" + (github?.identity ?? target.identity) + "/" + (directory ? "tree" : "blob")
      + "/" + (github?.ref ?? "main") + "/" + encoded + suffix;
  const label = (sameCheckout ? relative || "/" : target.identity.split("/")[1] + "/" + relative) + suffix;
  return { label, destination };
}

function f_formatRepositoryLink(targetPath, sourcePath, repositories, kind) {
  const { label, destination } = f_repositoryLinkParts(targetPath, sourcePath, repositories, kind);
  // Intraword underscores cannot start emphasis. Keeping them literal also
  // avoids Obsidian splitting ordinary file names into escaped text fragments.
  const escaped = label.replace(/([\\\[\]*`<>&~])|_+/gu, (match, punctuation, offset) => {
    if (!punctuation && /[\p{L}\p{N}]/u.test(label[offset - 1] ?? "")
      && /[\p{L}\p{N}]/u.test(label[offset + match.length] ?? "")) return match;
    return match.replace(/./g, "\\$&");
  });
  return "[" + escaped + "](" + destination + ")";
}

function f_rewriteRepositoryDestinations(markdown, {
  sourcePath, moves, repositories, repositoriesBefore = repositories, getTargetType, onError,
}) {
  const f_move = path => {
    for (const { oldPath, newPath } of moves) {
      if (path === oldPath || path.startsWith(oldPath + "/")) path = newPath + path.slice(oldPath.length);
    }
    return path;
  };
  let sourceBefore = sourcePath;
  for (const { oldPath, newPath } of moves.slice().reverse()) {
    if (sourceBefore === newPath || sourceBefore.startsWith(newPath + "/")) {
      sourceBefore = oldPath + sourceBefore.slice(newPath.length);
    }
  }
  const sourceMovedRepo = f_repositoryForPath(sourcePath, repositories)?.root !==
    f_repositoryForPath(sourceBefore, repositoriesBefore)?.root;
  const edits = [];
  for (const link of f_scanMarkdownLinks(markdown, { destinationRanges: true })) {
    if (!link.destinationRange) continue;
    const github = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:blob|tree)\//i.exec(link.destination);
    if (!github && (!link.destination.startsWith("/") || link.destination.startsWith("//"))) continue;
    const result = f_resolveRepositoryLink(link, {
      sourcePath: sourceBefore,
      repositories: repositoriesBefore,
      getTargetType: path => getTargetType(f_move(path)),
    });
    if (result.status !== "resolved" || /^[\da-f]{7,64}$/i.test(result.ref ?? "")) continue;
    const targetPath = f_move(result.vaultPath);
    const moved = targetPath !== result.vaultPath;
    if (!moved && !sourceMovedRepo) continue;
    if (!moved && github && f_resolveRepositoryLink(link, { sourcePath, repositories, getTargetType }).vaultPath === result.vaultPath) continue;
    const targetMovedRepo = f_repositoryForPath(targetPath, repositories)?.identity !==
      f_repositoryForPath(result.vaultPath, repositoriesBefore)?.identity;
    const url = github ? {
      identity: targetMovedRepo ? undefined : github[1],
      ref: targetMovedRepo ? encodeURIComponent(result.ref) : result.rawRef,
    } : undefined;
    let destination;
    try {
      ({ destination } = f_repositoryLinkParts(targetPath, sourcePath, repositories, result.kind, url));
    } catch (error) {
      onError?.(error, link.destination);
      continue;
    }
    const { start, end } = link.destinationRange;
    const raw = markdown.slice(start, end);
    // Keep the literal query/fragment, including Markdown escapes and entities.
    let pathEnd = end;
    for (const match of raw.matchAll(/\\[^\s]|&(?:#[xX]?[\da-fA-F]+|[a-zA-Z][\da-zA-Z]+);|[?#]/g)) {
      if (!/^[?#]/.test(markdownParser.utils.unescapeAll(match[0]))) continue;
      pathEnd = start + match.index;
      break;
    }
    edits.push({ start, end: pathEnd, destination });
  }
  let output = markdown;
  for (const { start, end, destination } of edits.sort((left, right) => right.start - left.start)) {
    output = output.slice(0, start) + destination + output.slice(end);
  }
  return output;
}

module.exports = {
  f_scanMarkdownLinks, f_originIdentity, f_repositoryForPath, f_resolveRepositoryLink,
  f_formatRepositoryLink, f_rewriteRepositoryDestinations,
};
