#!/usr/bin/env node
/**
 * verify.js — structural sanity checks for Otto
 * Catches the class of bug that `node --check` cannot: dead wiring, missing
 * elements, orphan tabs, render functions that never run.
 *
 * Usage (from the repo root):  node js/verify.js index.html
 * Exits non-zero if any check fails.
 */
const fs = require("fs");
const path = require("path");
const file = process.argv[2] || "index.html";
const html = fs.readFileSync(file, "utf8");

// JS may be inline (<script>...</script>) or external (<script src="js/app.js">).
// Support both so this still works whichever way a given deck.html is built.
const srcMatch = html.match(/<script[^>]*\ssrc=["']([^"']+)["'][^>]*>/);
const js = srcMatch
  ? fs.readFileSync(path.resolve(path.dirname(file), srcMatch[1]), "utf8")
  : (html.match(/<script>([\s\S]*?)<\/script>/) || [])[1] || "";

const problems = [];
const ok = [];
const fail = (m) => problems.push(m);
const pass = (m) => ok.push(m);

// ---- 1. syntax ----
try {
  new Function(js);            // parse-only; throws on syntax error
  pass("JS parses without syntax errors");
} catch (e) {
  fail("SYNTAX: " + e.message);
}

// ---- 2. every getElementById target exists in the HTML ----
const refs = [...new Set([...js.matchAll(/getElementById\(["'`]([^"'`]+)["'`]\)/g)].map(m => m[1]))];
const definedIds = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]));
let missing = refs.filter(id => !definedIds.has(id));
missing.length
  ? missing.forEach(id => fail(`getElementById("${id}") — no matching id="${id}" in the HTML`))
  : pass(`all ${refs.length} getElementById targets exist`);

// ---- 3. nav tabs <-> view sections are one-to-one ----
const tabs = [...new Set([...html.matchAll(/data-view=["']([^"']+)["']/g)].map(m => m[1]))];
const sections = new Set([...html.matchAll(/id=["']view-([^"']+)["']/g)].map(m => m[1]));
let navProblem = false;
tabs.forEach(v => { if (!sections.has(v)) { fail(`nav tab data-view="${v}" has no <section id="view-${v}">`); navProblem = true; } });
[...sections].forEach(s => { if (!tabs.includes(s)) { fail(`<section id="view-${s}"> has no nav tab`); navProblem = true; } });
if (!navProblem) pass(`all ${tabs.length} tabs map to a view section`);

// ---- 4. every render* function is invoked in renderAll ----
const renderFns = [...new Set([...js.matchAll(/function\s+(render[A-Z]\w*)\s*\(/g)].map(m => m[1]))].filter(f => f !== "renderAll");
const renderAllBody = (js.match(/function\s+renderAll\s*\([^)]*\)\s*\{([\s\S]*?)\n\s{2}\}/) || [])[1] || "";
let uncalled = renderFns.filter(f => !renderAllBody.includes(f + "("));
uncalled.length
  ? uncalled.forEach(f => fail(`${f}() is defined but never called in renderAll()`))
  : pass(`all ${renderFns.length} render functions run in renderAll`);

// ---- 5. interactive list/grid containers have an event handler ----
// (this is the check that would have caught the Later-tab dropdown bug)
const arrayHandlerIds = [];
[...js.matchAll(/\[([^\]]*?)\]\.forEach\(function\(cid\)/g)].forEach(m =>
  [...m[1].matchAll(/["'`]([^"'`]+)["'`]/g)].forEach(mm => arrayHandlerIds.push(mm[1]))
);
const directHandlerIds = [...js.matchAll(/getElementById\(["'`]([^"'`]+)["'`]\)\s*\.addEventListener/g)].map(m => m[1]);
const handled = new Set([...arrayHandlerIds, ...directHandlerIds]);
const IGNORE = new Set([]); // add genuinely static (non-interactive) lists here
const listIds = refs.filter(id => /(-list|-grid)$/.test(id) && !IGNORE.has(id));
let dead = listIds.filter(id => !handled.has(id));
dead.length
  ? dead.forEach(id => fail(`list container "${id}" is rendered but has NO event handler — its buttons/dropdowns will be dead`))
  : pass(`all ${listIds.length} interactive list containers are wired to handlers`);

// ---- report ----
console.log("\n  Otto structural check — " + file + "\n");
ok.forEach(m => console.log("  \u2713 " + m));
if (problems.length) {
  console.log("");
  problems.forEach(m => console.log("  \u2717 " + m));
  console.log("\n  " + problems.length + " problem(s) found.\n");
  process.exit(1);
}
console.log("\n  All checks passed.\n");
