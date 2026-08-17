// Standalone unit tests for workflow-mode/utils.ts.
// Run with: node --experimental-strip-types utils.test.ts
//
// We exercise the pure helpers in isolation. No pi runtime, no LLM.

import {
	buildReviewPrompt,
	buildStepDirective,
	cleanStepText,
	extractPlanSteps,
	isReadOnlyCommand,
	parseReviewVerdict,
	renderPlanMarkdown,
	type TodoItem,
} from "./utils.ts";

let passed = 0;
let failed = 0;

function expect<T>(label: string, actual: T, expected: T): void {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) {
		passed++;
		console.log(`ok ${label}`);
	} else {
		failed++;
		console.error(`FAIL ${label}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
	}
}

function expectMatch(label: string, actual: string, pattern: RegExp): void {
	if (pattern.test(actual)) {
		passed++;
		console.log(`ok ${label}`);
	} else {
		failed++;
		console.error(`FAIL ${label}\n  expected match: ${pattern}\n  actual:         ${actual}`);
	}
}

function expectTrue(label: string, condition: boolean): void {
	if (condition) {
		passed++;
		console.log(`ok ${label}`);
	} else {
		failed++;
		console.error(`FAIL ${label}`);
	}
}

// ---- extractPlanSteps --------------------------------------------------

expect("plan: 2 numbered steps from 'Plan:' header", extractPlanSteps("Some intro.\nPlan:\n1. Add X\n2. Add Y").length, 2);

const plan = extractPlanSteps("Reasoning.\n\nPlan:\n1. Add validation\n2. Extract helpers\n3. Write tests");
expect("plan: parses exactly 3 steps", plan.length, 3);
expect("plan: step 1 text", plan[0].text, "Add validation");
expect("plan: step 2 text", plan[1].text, "Extract helpers");
expect("plan: step 3 text", plan[2].text, "Write tests");
expect("plan: all steps start incomplete", plan.every((item) => !item.completed), true);

expect("plan: no 'Plan:' header returns empty list", extractPlanSteps("Just a sentence.").length, 0);

const refined = extractPlanSteps("Plan:\n1. Old step\nPlan:\n1. New step\n2. Another");
expect("plan: refined plan supersedes earlier draft", refined.length, 2);
expect("plan: refined step 1 text", refined[0].text, "New step");

expectTrue("plan: strips markdown emphasis from step text", extractPlanSteps("Plan:\n1. **Bold** step").every((item) => !item.text.includes("*")));

// ---- buildStepDirective ------------------------------------------------

const directiveItems: TodoItem[] = [
	{ step: 1, text: "do first", completed: true },
	{ step: 2, text: "do second", completed: false },
	{ step: 3, text: "do third", completed: false },
];
const directive = buildStepDirective(directiveItems);
expectMatch("directive: names the current step", directive!, /NOW: 2\. do second/);
expectMatch("directive: shows remaining steps", directive!, /After this step:[\s\S]*3\. do third/);
expectMatch("directive: explains settle-driven contract", directive!, /settled run as the unit of completion/);
expectMatch("directive: omits 'emit a marker' instruction", directive!, /Do not emit a \[DONE:n\] marker|settled run as the unit/);
expectTrue("directive: returns null when all complete", buildStepDirective([{ step: 1, text: "x", completed: true }]) === null);

const noteDirective = buildStepDirective(directiveItems, { note: "address the gap" });
expectMatch("directive: includes manager note", noteDirective!, /Note from the manager: address the gap/);

// ---- buildReviewPrompt --------------------------------------------------

const reviewItems: TodoItem[] = [
	{ step: 1, text: "do first", completed: true },
	{ step: 2, text: "do second", completed: false },
	{ step: 3, text: "do third", completed: false },
];
const review = buildReviewPrompt(reviewItems, reviewItems[1]);
expectMatch("review: names step under review", review, /auditing step 2/);
expectMatch("review: includes step text", review, /do second/);
expectMatch("review: lists completed steps", review, /Already done:[\s\S]*1\. do first ✓/);
expectMatch("review: lists remaining steps", review, /Still to do:[\s\S]*3\. do third/);
expectMatch("review: lists all three verdicts", review, /\[VERIFY:DONE\]/);
expectMatch("review: lists CONTINUE option", review, /\[VERIFY:CONTINUE:/);
expectMatch("review: lists BLOCKED option", review, /\[VERIFY:BLOCKED:/);
expectMatch("review: demands exactly one line", review, /EXACTLY ONE of these three lines/);

// ---- parseReviewVerdict -------------------------------------------------

expect("verdict: DONE marker", parseReviewVerdict("Looks good. [VERIFY:DONE]").kind, "done");

const continueVerdict = parseReviewVerdict("Halfway. [VERIFY:CONTINUE: missing tests]");
expect("verdict: CONTINUE marker kind", continueVerdict.kind, "continue");
expect("verdict: CONTINUE gap extracted", (continueVerdict as { gap: string }).gap, "missing tests");

const blockedVerdict = parseReviewVerdict("Impossible. [VERIFY:BLOCKED: no schema available]");
expect("verdict: BLOCKED marker kind", blockedVerdict.kind, "blocked");
expect("verdict: BLOCKED reason extracted", (blockedVerdict as { reason: string }).reason, "no schema available");

// Last occurrence wins (model may revise its mind)
const revised = parseReviewVerdict("[VERIFY:CONTINUE: half done] ... actually [VERIFY:DONE]");
expect("verdict: last occurrence wins", revised.kind, "done");

// Malformed = no marker
const malformed = parseReviewVerdict("I think it's done but I'm not sure.");
expect("verdict: malformed when no marker", malformed.kind, "malformed");

// Empty gap
const emptyContinue = parseReviewVerdict("[VERIFY:CONTINUE: ]");
expect("verdict: empty gap preserved", (emptyContinue as { gap: string }).gap, "");

// CONTINUE without closing bracket (e.g., model forgot to close)
const unclosed = parseReviewVerdict("[VERIFY:CONTINUE: gap that runs on");
expect("verdict: unclosed CONTINUE falls through to malformed", unclosed.kind, "malformed");

// Multiple distinct verdicts: last by source order wins
const mixed = parseReviewVerdict("first [VERIFY:DONE] then [VERIFY:BLOCKED: oops]");
expect("verdict: later verdict wins on same turn", mixed.kind, "blocked");

// ---- isReadOnlyCommand ---------------------------------------------------

expect("bash: cat is read-only", isReadOnlyCommand("cat README.md"), true);
expect("bash: rm is blocked", isReadOnlyCommand("rm -rf /"), false);
expect("bash: redirect to file is blocked", isReadOnlyCommand("cat foo > bar"), false);
expect("bash: redirect to file via heredoc blocked", isReadOnlyCommand("echo hi >> file"), false);
expect("bash: curl to stdout allowed", isReadOnlyCommand("curl https://example.com"), true);
expect("bash: curl -o file is blocked", isReadOnlyCommand("curl -o out.html https://example.com"), false);
expect("bash: git status allowed", isReadOnlyCommand("git status"), true);
expect("bash: git commit blocked", isReadOnlyCommand("git commit -m x"), false);
expect("bash: npm install blocked", isReadOnlyCommand("npm install lodash"), false);
expect("bash: npm list allowed", isReadOnlyCommand("npm list"), true);
expect("bash: sudo blocked", isReadOnlyCommand("sudo ls"), false);

// ---- renderPlanMarkdown ------------------------------------------------

const md = renderPlanMarkdown(directiveItems);
expectMatch("render: includes 'Workflow' title", md, /^# Workflow/m);
expectMatch("render: marks completed with x", md, /- \[x\] 1\. do first/);
expectMatch("render: marks incomplete with space", md, /- \[ \] 2\. do second/);
expectMatch("render: summary line", md, /Summary: 1\/3 steps complete/);

// ---- cleanStepText (private but exported) -------------------------------

expect("clean: strips **bold**", cleanStepText("**hello** world"), "hello world");
expect("clean: strips `code`", cleanStepText("`x` and `y`"), "x and y");
expect("clean: collapses whitespace", cleanStepText("a   b\n\n  c"), "a b c");
expect("clean: truncates long text", cleanStepText("a".repeat(100)).length <= 81, true);

// ---- Summary ------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
