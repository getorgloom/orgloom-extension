(function () {
	'use strict';
	// Runs user-authored transformations in a restricted interpreter with all-or-nothing rollback.

	window.OrgLoom = window.OrgLoom || {};

	window.OrgLoom.bulkScript = {
		mount: function mount(deps) {
			if (
				!deps ||
				!deps.canvasState ||
				!deps.csrfFetch ||
				!deps.refreshCapabilities ||
				!deps.showBulkToast ||
				!deps.renderBulkView ||
				!deps.showConfirmDialog
			) {
				throw new Error('bulk-script.mount: missing required deps');
			}
			const canvasState = deps.canvasState;
			const csrfFetch = deps.csrfFetch;
			const refreshCapabilities = deps.refreshCapabilities;
			const showBulkToast = deps.showBulkToast;
			const showBulkToastWithAction = deps.showBulkToastWithAction || null;
			const renderBulkView = deps.renderBulkView;
			const showConfirmDialog = deps.showConfirmDialog;

			const bulkScriptModal = document.createElement('div');
			bulkScriptModal.className = 'modal hidden';
			bulkScriptModal.innerHTML =
				'<div class="modal-overlay" data-bs-close></div>' +
				'<div class="modal-body" style="max-width:780px">' +
				'<div class="modal-header">' +
				'<h3>Run script on records</h3>' +
				'<button class="modal-close" data-bs-close>&times;</button>' +
				'</div>' +
				'<div class="modal-content">' +
				'<textarea id="bs-source" class="bs-source" spellcheck="false" autocomplete="off" autocorrect="off"></textarea>' +
				'<details class="bs-cheatsheet">' +
				'<summary>Cheat sheet</summary>' +
				'<div class="bs-cheatsheet-body">' +
				'<p class="bs-blurb">JavaScript that runs locally against the records on your canvas. Nothing is sent to Salesforce until you click <em>Upload to Salesforce</em>.</p>' +
				'<h4>Recipes</h4>' +
				'<pre class="bs-recipe">// Bump every Opportunity Amount by 10%\n' +
				'for (const r of records) {\n' +
				"  if (r.objectName === 'Opportunity' &amp;&amp; r.values.Amount) {\n" +
				'    r.values.Amount = toNum(r.values.Amount) * 1.1;\n' +
				'  }\n' +
				'}</pre>' +
				'<pre class="bs-recipe">// Set Stage = "Closed Lost" on every Opp with no Amount\n' +
				'for (const r of records) {\n' +
				"  if (r.objectName === 'Opportunity' &amp;&amp; isBlank(r.values.Amount)) {\n" +
				"    r.values.StageName = 'Closed Lost';\n" +
				'  }\n' +
				'}</pre>' +
				'<h4>What you can use</h4>' +
				'<ul class="bs-vars">' +
				'<li><code>records</code>: every card on the canvas. Each has <code>id</code>, <code>objectName</code>, <code>label</code>, <code>values</code>, and (for loaded SF rows) <code>loadedFromId</code>. Edit a field with <code>r.values.FieldName = ...</code>.</li>' +
				'<li><code>r.loadedFromId</code>: the Salesforce Id of the row a card was pulled from. Set on cards loaded via Browse / SOQL / record-browse; empty on drafts you created on the canvas. At Upload time, cards <em>with</em> <code>loadedFromId</code> become UPDATEs and cards <em>without</em> become INSERTs, so this is the field to check when you want to touch only one or the other:' +
				'<pre class="bs-recipe">// Only update existing SF rows, leave drafts alone\n' +
				'for (const r of records) {\n' +
				'  if (r.loadedFromId) {\n' +
				'    r.values.LastReviewed__c = today();\n' +
				'  }\n' +
				'}</pre>' +
				'</li>' +
				'<li><strong>Helpers</strong>: <code>log(x)</code>, <code>abort(msg)</code>, <code>isBlank(x)</code>, <code>isNotBlank(x)</code>, <code>isEmpty(x)</code>, <code>isNotEmpty(x)</code>, <code>today()</code>, <code>now()</code>, <code>daysFromToday(n)</code>, <code>toStr(x)</code>, <code>toNum(x)</code>, <code>max(a,b)</code>, <code>min(a,b)</code>, <code>round(x)</code>, <code>floor(x)</code>, <code>ceil(x)</code>, <code>abs(x)</code>.</li>' +
				'</ul>' +
				'<h4>Quick syntax reference</h4>' +
				'<ul class="bs-syntax">' +
				'<li><code>let</code> / <code>const</code>, <code>if/else</code>, <code>for (const r of records)</code>, <code>break</code>, <code>continue</code></li>' +
				'<li>Operators: <code>+ - * / %</code>, <code>== != === !==</code>, <code>&lt; &lt;= &gt; &gt;=</code>, <code>&amp;&amp; ||</code>, ternary <code>?:</code>, <code>+= -= *= /= %=</code></li>' +
				'<li>Comments: <code>//</code> and <code>/* */</code>. Strings: <code>\'foo\'</code> or <code>"foo"</code>.</li>' +
				'</ul>' +
				'<details class="bs-nested">' +
				"<summary>What's NOT supported (and why)</summary>" +
				"<p>This is a safe subset of JavaScript run by a hand-written interpreter, not the browser's. To keep the sandbox honest, several things are unavailable on purpose:</p>" +
				'<ul>' +
				'<li><strong>Functions you write</strong> (arrow fns, function declarations), <code>this</code>, <code>new</code>, <code>try/catch</code>, <code>while</code>, classic <code>for(;;)</code>, regex literals, template strings, spread, destructuring, <code>async</code>/<code>await</code>.</li>' +
				'<li><strong>Browser surface</strong>: <code>fetch</code>, <code>document</code>, <code>window</code>, <code>localStorage</code>, <code>setTimeout</code>. None are exposed.</li>' +
				'<li><strong>Property names that escape sandboxes</strong>: <code>constructor</code>, <code>__proto__</code>, <code>prototype</code>. Blocked.</li>' +
				'<li>SOQL, DML, <code>@future</code>: not available here. Use Upload to push changes to Salesforce.</li>' +
				'</ul>' +
				'</details>' +
				'<details class="bs-nested">' +
				'<summary>Coming from Apex?</summary>' +
				'<div class="bs-map-wrap" tabindex="0" role="region" aria-label="Apex and script comparison"><table class="bs-map">' +
				'<thead><tr><th scope="col">Apex</th><th scope="col">Script here</th></tr></thead><tbody>' +
				'<tr><td><code>for (Account a : records)</code></td><td><code>for (const a of records)</code></td></tr>' +
				'<tr><td><code>String.isBlank(x)</code></td><td><code>isBlank(x)</code></td></tr>' +
				'<tr><td><code>Date.today()</code></td><td><code>today()</code></td></tr>' +
				'<tr><td><code>record.Field__c</code></td><td><code>r.values.Field__c</code></td></tr>' +
				"<tr><td><code>String x = 'foo';</code></td><td><code>let x = 'foo';</code></td></tr>" +
				'<tr><td><code>Math.max(a, b)</code></td><td><code>max(a, b)</code></td></tr>' +
				'</tbody></table></div>' +
				'</details>' +
				'<p class="bs-footnotes"><strong>Heads up:</strong> <code>Ctrl/Cmd+Enter</code> runs the script. Errors roll back every change. <code>r.id</code> and <code>r.loadedFromId</code> are read-only.</p>' +
				'</div>' +
				'</details>' +
				'<div id="bs-output" class="bs-output" hidden></div>' +
				'</div>' +
				'<div class="modal-footer">' +
				'<span class="bs-counter" id="bs-counter"></span>' +
				'<button class="button secondary" data-bs-close>Cancel</button>' +
				'<button class="button" id="bs-run">Run</button>' +
				'</div>' +
				'</div>';
			document.body.appendChild(bulkScriptModal);
			bulkScriptModal
				.querySelectorAll('[data-bs-close]')
				.forEach((el) => el.addEventListener('click', closeBulkScriptModal));
			document.addEventListener('keydown', (e) => {
				if (e.key === 'Escape' && !bulkScriptModal.classList.contains('hidden')) {
					closeBulkScriptModal();
				}
			});

			const _bsExample =
				'// Example: bump every Opportunity Amount by 10%\n' +
				'for (const r of records) {\n' +
				"\tif (r.objectName === 'Opportunity' && r.values.Amount) {\n" +
				'\t\tr.values.Amount = toNum(r.values.Amount) * 1.1;\n' +
				'\t}\n' +
				'}\n';
			let _bsLastSource = _bsExample;

			function _bsScriptableRecords() {
				return canvasState.bulkRecords.filter((r) => r && !r.isTypeNode && !r.isPending);
			}

			function openBulkScriptModal() {
				if (_bsScriptableRecords().length === 0) {
					showBulkToast('Add some records first.', 'error');
					return;
				}
				const ta = bulkScriptModal.querySelector('#bs-source');
				ta.value = _bsLastSource;
				const out = bulkScriptModal.querySelector('#bs-output');
				out.hidden = true;
				out.textContent = '';
				out.className = 'bs-output';
				const counter = bulkScriptModal.querySelector('#bs-counter');
				const runButton = bulkScriptModal.querySelector('#bs-run');
				const userVisible = _bsScriptableRecords().length;
				counter.textContent = userVisible + ' record' + (userVisible === 1 ? '' : 's');
				runButton.disabled = false;
				runButton.textContent = 'Run';
				bulkScriptModal.classList.remove('hidden');
				setTimeout(() => ta.focus(), 0);
			}

			function closeBulkScriptModal() {
				const ta = bulkScriptModal.querySelector('#bs-source');
				if (ta) {
					_bsLastSource = ta.value;
				}
				bulkScriptModal.classList.add('hidden');
			}

			function _bsBuildHelpers() {
				const isBlank = (s) => s == null || String(s).trim() === '';
				const isNotBlank = (s) => !isBlank(s);
				const isEmpty = (s) => s == null || String(s).length === 0;
				const isNotEmpty = (s) => !isEmpty(s);
				const pad = (n) => String(n).padStart(2, '0');
				const today = () => {
					const d = new Date();
					return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
				};
				const now = () => new Date().toISOString();
				const daysFromToday = (n) => {
					const d = new Date();
					d.setDate(d.getDate() + Number(n));
					return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
				};
				return { isBlank, isNotBlank, isEmpty, isNotEmpty, today, now, daysFromToday };
			}

			function _bsRender(out, kind, text) {
				out.hidden = false;
				out.className = 'bs-output bs-output--' + kind;
				out.textContent = text;
			}

			const _BS_KEYWORDS = [
				'let',
				'const',
				'if',
				'else',
				'for',
				'of',
				'true',
				'false',
				'null',
				'break',
				'continue',
			];
			const _BS_OPS_MULTI = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%='];
			const _BS_OPS_SINGLE = '+-*/%<>=!?:.,;(){}[]';
			const _BS_FORBIDDEN_PROPS = new Set([
				'constructor',
				'__proto__',
				'prototype',
				'__defineGetter__',
				'__defineSetter__',
				'__lookupGetter__',
				'__lookupSetter__',
			]);
			const _BS_MAX_STEPS = 1000000;
			const _BS_BREAK = Symbol('break');
			const _BS_CONTINUE = Symbol('continue');

			function _bsTokenize(src) {
				const toks = [];
				let i = 0,
					line = 1,
					col = 1;
				const advance = () => {
					const c = src[i++];
					if (c === '\n') {
						line++;
						col = 1;
					} else {
						col++;
					}
					return c;
				};
				const peek = (n) => src[i + (n || 0)];
				const isIdStart = (c) => /[A-Za-z_$]/.test(c);
				const isIdPart = (c) => /[A-Za-z0-9_$]/.test(c);
				const isDigit = (c) => c >= '0' && c <= '9';

				while (i < src.length) {
					const c = src[i];
					if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
						advance();
						continue;
					}
					if (c === '/' && peek(1) === '/') {
						while (i < src.length && src[i] !== '\n') {
							advance();
						}
						continue;
					}
					if (c === '/' && peek(1) === '*') {
						advance();
						advance();
						while (i < src.length && !(src[i] === '*' && peek(1) === '/')) {
							advance();
						}
						if (i < src.length) {
							advance();
							advance();
						}
						continue;
					}
					const startLine = line,
						startCol = col;
					if (isDigit(c) || (c === '.' && isDigit(peek(1)))) {
						let s = '';
						while (i < src.length && (isDigit(src[i]) || src[i] === '.')) {
							s += advance();
						}
						if (s.split('.').length > 2 || Number.isNaN(Number(s))) {
							throw new Error('Malformed number "' + s + '" at line ' + startLine);
						}
						toks.push({ type: 'num', value: Number(s), line: startLine, col: startCol });
						continue;
					}
					if (c === '"' || c === "'") {
						const quote = c;
						advance();
						let s = '';
						while (i < src.length && src[i] !== quote) {
							if (src[i] === '\\') {
								advance();
								const esc = advance();
								const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', 0: '\0' };
								s += esc in map ? map[esc] : esc;
							} else {
								s += advance();
							}
						}
						if (i >= src.length) {
							throw new Error('Unterminated string at line ' + startLine);
						}
						advance();
						toks.push({ type: 'str', value: s, line: startLine, col: startCol });
						continue;
					}
					if (isIdStart(c)) {
						let s = '';
						while (i < src.length && isIdPart(src[i])) {
							s += advance();
						}
						const type = _BS_KEYWORDS.indexOf(s) !== -1 ? s : 'id';
						toks.push({ type, value: s, line: startLine, col: startCol });
						continue;
					}
					let matched = null;
					for (let k = 0; k < _BS_OPS_MULTI.length; k++) {
						const op = _BS_OPS_MULTI[k];
						if (src.substr(i, op.length) === op) {
							matched = op;
							break;
						}
					}
					if (matched) {
						for (let k = 0; k < matched.length; k++) {
							advance();
						}
						toks.push({ type: 'op', value: matched, line: startLine, col: startCol });
						continue;
					}
					if (_BS_OPS_SINGLE.indexOf(c) !== -1) {
						advance();
						toks.push({ type: 'op', value: c, line: startLine, col: startCol });
						continue;
					}
					throw new Error('Unexpected character "' + c + '" at line ' + startLine + ', col ' + startCol);
				}
				toks.push({ type: 'eof', line, col });
				return toks;
			}

			function _bsParse(tokens) {
				// Parse a small supported language instead of evaluating arbitrary JavaScript.
				let pos = 0;
				const peek = (n) => tokens[pos + (n || 0)];
				const eat = () => tokens[pos++];
				const check = (type, value) => {
					const t = peek();
					return t.type === type && (value === undefined || t.value === value);
				};
				const consume = (type, value, msg) => {
					if (!check(type, value)) {
						const t = peek();
						throw new Error(
							'Parse error at line ' +
								t.line +
								': expected ' +
								(value || type) +
								', got "' +
								(t.value !== undefined ? t.value : t.type) +
								'"' +
								(msg ? ' (' + msg + ')' : ''),
						);
					}
					return eat();
				};

				function parseProgram() {
					const body = [];
					while (!check('eof')) {
						body.push(parseStatement());
					}
					return { type: 'program', body };
				}
				function parseStatement() {
					if (check('let') || check('const')) {
						return parseLet();
					}
					if (check('if')) {
						return parseIf();
					}
					if (check('for')) {
						return parseFor();
					}
					if (check('break')) {
						eat();
						maybeSemi();
						return { type: 'break' };
					}
					if (check('continue')) {
						eat();
						maybeSemi();
						return { type: 'continue' };
					}
					if (check('op', '{')) {
						return parseBlock();
					}
					const expr = parseExpression();
					maybeSemi();
					return { type: 'expr', expr };
				}
				function parseLet() {
					const kind = eat().type;
					const name = consume('id', undefined, 'variable name').value;
					consume('op', '=', 'expected "="');
					const init = parseExpression();
					maybeSemi();
					return { type: 'let', kind, name, init };
				}
				function parseIf() {
					eat();
					consume('op', '(');
					const cond = parseExpression();
					consume('op', ')');
					const then = parseStatement();
					let alt = null;
					if (check('else')) {
						eat();
						alt = parseStatement();
					}
					return { type: 'if', cond, then, else: alt };
				}
				function parseFor() {
					eat();
					consume('op', '(');
					if (!(check('let') || check('const'))) {
						throw new Error('Only "for (let x of arr)" / "for (const x of arr)" form is supported');
					}
					const kind = eat().type;
					const name = consume('id').value;
					consume('of', undefined, 'expected "of"');
					const iter = parseExpression();
					consume('op', ')');
					const body = parseStatement();
					return { type: 'forof', name, kind, iterable: iter, body };
				}
				function parseBlock() {
					consume('op', '{');
					const body = [];
					while (!check('op', '}') && !check('eof')) {
						body.push(parseStatement());
					}
					consume('op', '}');
					return { type: 'block', body };
				}
				function maybeSemi() {
					if (check('op', ';')) {
						eat();
					}
				}

				function parseExpression() {
					return parseAssign();
				}
				const ASSIGN_OPS = ['=', '+=', '-=', '*=', '/=', '%='];
				function parseAssign() {
					const left = parseTernary();
					if (check('op') && ASSIGN_OPS.indexOf(peek().value) !== -1) {
						const op = eat().value;
						const right = parseAssign();
						return { type: 'assign', op, target: left, value: right };
					}
					return left;
				}
				function parseTernary() {
					const cond = parseLogicOr();
					if (check('op', '?')) {
						eat();
						const then = parseExpression();
						consume('op', ':');
						const alt = parseExpression();
						return { type: 'ternary', cond, then, else: alt };
					}
					return cond;
				}
				function parseLogicOr() {
					let left = parseLogicAnd();
					while (check('op', '||')) {
						eat();
						left = { type: 'logical', op: '||', left, right: parseLogicAnd() };
					}
					return left;
				}
				function parseLogicAnd() {
					let left = parseEquality();
					while (check('op', '&&')) {
						eat();
						left = { type: 'logical', op: '&&', left, right: parseEquality() };
					}
					return left;
				}
				function parseEquality() {
					let left = parseComparison();
					while (check('op', '==') || check('op', '!=') || check('op', '===') || check('op', '!==')) {
						const op = eat().value;
						left = { type: 'binary', op, left, right: parseComparison() };
					}
					return left;
				}
				function parseComparison() {
					let left = parseAdditive();
					while (check('op', '<') || check('op', '<=') || check('op', '>') || check('op', '>=')) {
						const op = eat().value;
						left = { type: 'binary', op, left, right: parseAdditive() };
					}
					return left;
				}
				function parseAdditive() {
					let left = parseMultiplicative();
					while (check('op', '+') || check('op', '-')) {
						const op = eat().value;
						left = { type: 'binary', op, left, right: parseMultiplicative() };
					}
					return left;
				}
				function parseMultiplicative() {
					let left = parseUnary();
					while (check('op', '*') || check('op', '/') || check('op', '%')) {
						const op = eat().value;
						left = { type: 'binary', op, left, right: parseUnary() };
					}
					return left;
				}
				function parseUnary() {
					if (check('op', '!') || check('op', '-') || check('op', '+')) {
						const op = eat().value;
						return { type: 'unary', op, arg: parseUnary() };
					}
					return parsePostfix();
				}
				function parsePostfix() {
					let node = parsePrimary();
					while (true) {
						if (check('op', '.')) {
							eat();
							const name = consume('id', undefined, 'expected property name').value;
							node = { type: 'member', object: node, property: name, computed: false };
						} else if (check('op', '[')) {
							eat();
							const key = parseExpression();
							consume('op', ']');
							node = { type: 'member', object: node, property: key, computed: true };
						} else if (check('op', '(')) {
							eat();
							const args = [];
							if (!check('op', ')')) {
								args.push(parseExpression());
								while (check('op', ',')) {
									eat();
									args.push(parseExpression());
								}
							}
							consume('op', ')');
							node = { type: 'call', callee: node, args };
						} else {
							break;
						}
					}
					return node;
				}
				function parsePrimary() {
					const t = peek();
					if (t.type === 'num' || t.type === 'str') {
						eat();
						return { type: 'lit', value: t.value };
					}
					if (t.type === 'true') {
						eat();
						return { type: 'lit', value: true };
					}
					if (t.type === 'false') {
						eat();
						return { type: 'lit', value: false };
					}
					if (t.type === 'null') {
						eat();
						return { type: 'lit', value: null };
					}
					if (t.type === 'id') {
						eat();
						return { type: 'ident', name: t.value };
					}
					if (t.type === 'op' && t.value === '(') {
						eat();
						const e = parseExpression();
						consume('op', ')');
						return e;
					}
					throw new Error(
						'Unexpected token "' + (t.value !== undefined ? t.value : t.type) + '" at line ' + t.line,
					);
				}

				return parseProgram();
			}

			function _bsInterpret(ast, env) {
				let steps = 0;
				const _identityGuarded = new Set(Array.isArray(env.records) ? env.records : []);
				const _IDENTITY_PROPS = new Set(['id', 'loadedFromId', 'values']);
				function tick() {
					if (++steps > _BS_MAX_STEPS) {
						throw new Error('Script exceeded ' + _BS_MAX_STEPS + ' steps (possible infinite loop)');
					}
				}
				function makeScope(parent) {
					return { vars: new Map(), parent };
				}
				function lookup(scope, name) {
					let s = scope;
					while (s) {
						if (s.vars.has(name)) {
							return s.vars.get(name);
						}
						s = s.parent;
					}
					throw new Error('Undefined identifier: ' + name);
				}
				function defineVar(scope, name, value) {
					if (scope.vars.has(name)) {
						throw new Error('Variable "' + name + '" is already defined in this scope');
					}
					scope.vars.set(name, value);
				}
				function assignVar(scope, name, value) {
					let s = scope;
					while (s) {
						if (s.vars.has(name)) {
							s.vars.set(name, value);
							return;
						}
						s = s.parent;
					}
					throw new Error('Cannot assign to undeclared variable: ' + name);
				}
				function checkProp(prop) {
					if (_BS_FORBIDDEN_PROPS.has(String(prop))) {
						throw new Error('Property "' + prop + '" is not allowed');
					}
				}
				function readMember(obj, prop) {
					if (obj == null) {
						throw new Error('Cannot read property "' + prop + '" of ' + obj);
					}
					checkProp(prop);
					return obj[prop];
				}
				function writeMember(obj, prop, value) {
					if (obj == null) {
						throw new Error('Cannot write property "' + prop + '" of ' + obj);
					}
					checkProp(prop);
					if (_identityGuarded.has(obj) && _IDENTITY_PROPS.has(String(prop))) {
						throw new Error(
							'Record identity is read-only: cannot assign r.' + prop + ' (edit r.values.* instead)',
						);
					}
					obj[prop] = value;
				}
				function applyAssignOp(op, oldVal, r) {
					if (op === '=') {
						return r;
					}
					if (op === '+=') {
						return oldVal + r;
					}
					if (op === '-=') {
						return oldVal - r;
					}
					if (op === '*=') {
						return oldVal * r;
					}
					if (op === '/=') {
						return oldVal / r;
					}
					return oldVal % r;
				}

				function evalExpr(node, scope) {
					tick();
					switch (node.type) {
						case 'lit':
							return node.value;
						case 'ident':
							return lookup(scope, node.name);
						case 'member': {
							const obj = evalExpr(node.object, scope);
							const prop = node.computed ? evalExpr(node.property, scope) : node.property;
							return readMember(obj, prop);
						}
						case 'call': {
							const args = node.args.map((a) => evalExpr(a, scope));
							let fn, thisArg;
							if (node.callee.type === 'member') {
								const obj = evalExpr(node.callee.object, scope);
								const prop = node.callee.computed
									? evalExpr(node.callee.property, scope)
									: node.callee.property;
								fn = readMember(obj, prop);
								thisArg = obj;
							} else {
								fn = evalExpr(node.callee, scope);
								thisArg = undefined;
							}
							if (typeof fn !== 'function') {
								throw new Error('Cannot call non-function');
							}
							return fn.apply(thisArg, args);
						}
						case 'unary': {
							const v = evalExpr(node.arg, scope);
							if (node.op === '!') {
								return !v;
							}
							if (node.op === '-') {
								return -v;
							}
							return +v;
						}
						case 'binary': {
							const l = evalExpr(node.left, scope);
							const r = evalExpr(node.right, scope);
							switch (node.op) {
								case '+':
									return l + r;
								case '-':
									return l - r;
								case '*':
									return l * r;
								case '/':
									return l / r;
								case '%':
									return l % r;
								case '==':
									return l == r;
								case '!=':
									return l != r;
								case '===':
									return l === r;
								case '!==':
									return l !== r;
								case '<':
									return l < r;
								case '<=':
									return l <= r;
								case '>':
									return l > r;
								case '>=':
									return l >= r;
							}
							throw new Error('Unknown binary op');
						}
						case 'logical': {
							const l = evalExpr(node.left, scope);
							if (node.op === '&&') {
								return l ? evalExpr(node.right, scope) : l;
							}
							return l ? l : evalExpr(node.right, scope);
						}
						case 'ternary':
							return evalExpr(node.cond, scope) ? evalExpr(node.then, scope) : evalExpr(node.else, scope);
						case 'assign': {
							const r = evalExpr(node.value, scope);
							const target = node.target;
							if (target.type === 'ident') {
								const oldVal = node.op === '=' ? undefined : lookup(scope, target.name);
								const v = applyAssignOp(node.op, oldVal, r);
								assignVar(scope, target.name, v);
								return v;
							}
							if (target.type === 'member') {
								const obj = evalExpr(target.object, scope);
								const prop = target.computed ? evalExpr(target.property, scope) : target.property;
								const oldVal = node.op === '=' ? undefined : readMember(obj, prop);
								const v = applyAssignOp(node.op, oldVal, r);
								writeMember(obj, prop, v);
								return v;
							}
							throw new Error('Invalid assignment target');
						}
					}
					throw new Error('Unknown expression: ' + node.type);
				}

				function execStmt(node, scope) {
					tick();
					switch (node.type) {
						case 'expr':
							evalExpr(node.expr, scope);
							return;
						case 'let':
							defineVar(scope, node.name, evalExpr(node.init, scope));
							return;
						case 'block': {
							const inner = makeScope(scope);
							for (let k = 0; k < node.body.length; k++) {
								const r = execStmt(node.body[k], inner);
								if (r === _BS_BREAK || r === _BS_CONTINUE) {
									return r;
								}
							}
							return;
						}
						case 'if':
							if (evalExpr(node.cond, scope)) {
								return execStmt(node.then, scope);
							}
							if (node.else) {
								return execStmt(node.else, scope);
							}
							return;
						case 'forof': {
							const iter = evalExpr(node.iterable, scope);
							if (iter == null || typeof iter[Symbol.iterator] !== 'function') {
								throw new Error('for-of: value is not iterable');
							}
							for (const v of iter) {
								const inner = makeScope(scope);
								inner.vars.set(node.name, v);
								const r = execStmt(node.body, inner);
								if (r === _BS_BREAK) {
									break;
								}
								if (r === _BS_CONTINUE) {
									continue;
								}
							}
							return;
						}
						case 'break':
							return _BS_BREAK;
						case 'continue':
							return _BS_CONTINUE;
					}
					throw new Error('Unknown statement: ' + node.type);
				}

				const root = makeScope(null);
				Object.keys(env).forEach((k) => root.vars.set(k, env[k]));
				for (let k = 0; k < ast.body.length; k++) {
					execStmt(ast.body[k], root);
				}
			}

			function runBulkScript(source) {
				const out = bulkScriptModal.querySelector('#bs-output');
				_bsLastSource = source;

				// Snapshot every record so syntax/runtime failures leave the canvas unchanged.
				const recordSnapshots = new Map();
				canvasState.bulkRecords.forEach((r) => {
					let snap;
					try {
						snap = structuredClone(r);
					} catch (_) {
						snap = { values: r.values ? Object.assign({}, r.values) : {} };
					}
					recordSnapshots.set(r.id, snap);
				});

				const records = _bsScriptableRecords();

				const logs = [];
				const log = function () {
					const args = Array.prototype.slice.call(arguments);
					logs.push(
						args
							.map((a) => {
								if (typeof a === 'string') {
									return a;
								}
								try {
									return JSON.stringify(a);
								} catch (_) {
									return String(a);
								}
							})
							.join(' '),
					);
				};
				const abort = (msg) => {
					throw new Error(msg || 'Script aborted');
				};
				const h = _bsBuildHelpers();

				let ast;
				try {
					const tokens = _bsTokenize(source);
					ast = _bsParse(tokens);
				} catch (err) {
					_bsRender(out, 'error', 'Syntax error: ' + (err.message || err));
					return;
				}

				const env = {
					records: records,
					log: log,
					abort: abort,
					isBlank: h.isBlank,
					isNotBlank: h.isNotBlank,
					isEmpty: h.isEmpty,
					isNotEmpty: h.isNotEmpty,
					today: h.today,
					now: h.now,
					daysFromToday: h.daysFromToday,
					toStr: (x) => String(x),
					toNum: (x) => Number(x),
					max: Math.max,
					min: Math.min,
					round: Math.round,
					floor: Math.floor,
					ceil: Math.ceil,
					abs: Math.abs,
				};

				const rollbackAll = () => {
					canvasState.bulkRecords.forEach((r) => {
						const snap = recordSnapshots.get(r.id);
						if (!snap) {
							return;
						}
						for (const key of Object.keys(r)) {
							if (!(key in snap)) {
								delete r[key];
							}
						}
						Object.assign(r, snap);
					});
				};
				const renderScriptError = (msg) => {
					const lines = [];
					if (logs.length) {
						lines.push('--- log ---', logs.join('\n'), '');
					}
					lines.push('Error: ' + msg, '(no changes applied)');
					_bsRender(out, 'error', lines.join('\n'));
				};

				const t0 = typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
				let elapsed;
				let changed = 0;
				const changedRecords = [];
				try {
					_bsInterpret(ast, env);
					elapsed = (
						(typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()) - t0
					).toFixed(1);
					canvasState.bulkRecords.forEach((r) => {
						const snap = recordSnapshots.get(r.id);
						if (!snap) {
							return;
						}
						if (JSON.stringify(snap.values || {}) !== JSON.stringify(r.values || {})) {
							changed++;
							changedRecords.push(r);
						}
					});
				} catch (err) {
					rollbackAll();
					const raw = err && err.message ? err.message : String(err);
					const msg = /circular/i.test(raw)
						? 'A field was set to point back at its own record (circular reference). Nothing was applied; set r.values fields to plain values, not the record or values object itself.'
						: raw;
					renderScriptError(msg);
					return;
				}

				// Explicit canvas links override lookup values at upload time. Remove
				// only links whose source field changed, after all script validation succeeds.
				const changedById = new Map(changedRecords.map((r) => [r.id, r]));
				const removedLinks = [];
				canvasState.bulkAssociations = (canvasState.bulkAssociations || []).filter((link) => {
					const rec = changedById.get(link.fromId);
					if (!rec) return true;
					const before = recordSnapshots.get(rec.id).values || {};
					const after = rec.values || {};
					if (
						Object.prototype.hasOwnProperty.call(before, link.fieldName) ===
							Object.prototype.hasOwnProperty.call(after, link.fieldName) &&
						JSON.stringify(before[link.fieldName]) === JSON.stringify(after[link.fieldName])
					)
						return true;
					removedLinks.push({ ...link });
					if (canvasState.bulkSelectedEdgeId === link.id) canvasState.bulkSelectedEdgeId = null;
					return false;
				});

				if (changed > 0) {
					renderBulkView();
				}
				const lines = [];
				if (logs.length) {
					lines.push('--- log ---', logs.join('\n'), '');
				}
				lines.push(
					'OK · ' + changed + ' record' + (changed === 1 ? '' : 's') + ' changed · ' + elapsed + ' ms',
				);
				_bsRender(out, changed > 0 ? 'ok' : 'info', lines.join('\n'));
				if (changed > 0) {
					const _doneMsg = 'Script updated ' + changed + ' record' + (changed === 1 ? '' : 's') + '.';
					if (showBulkToastWithAction) {
						const expectedRecords = new Map(changedRecords.map((r) => [r, JSON.stringify(r)]));
						const currentLinks = () =>
							JSON.stringify(
								(canvasState.bulkAssociations || []).filter((a) => changedById.has(a.fromId)),
							);
						const expectedLinks = currentLinks();
						showBulkToastWithAction(_doneMsg, 'Undo', () => {
							const stale =
								currentLinks() !== expectedLinks ||
								changedRecords.some(
									(r) =>
										!canvasState.bulkRecords.includes(r) ||
										JSON.stringify(r) !== expectedRecords.get(r),
								) ||
								removedLinks.some(
									(link) =>
										!canvasState.bulkRecords.some((r) => r.id === link.toId) ||
										(canvasState.bulkAssociations || []).some(
											(a) =>
												a.id === link.id ||
												(a.fromId === link.fromId && a.fieldName === link.fieldName),
										),
								);
							if (stale) {
								showBulkToast(
									'Can\u2019t undo Run script because affected records or relationships changed afterward.',
									'info',
								);
								return;
							}
							changedRecords.forEach((r) => {
								const snap = recordSnapshots.get(r.id);
								for (const key of Object.keys(r)) if (!(key in snap)) delete r[key];
								Object.assign(r, structuredClone(snap));
							});
							canvasState.bulkAssociations = (canvasState.bulkAssociations || []).concat(removedLinks);
							renderBulkView();
							showBulkToast(
								'Reverted the script’s changes to ' +
									changed +
									' record' +
									(changed === 1 ? '' : 's') +
									'.',
							);
						});
					} else {
						showBulkToast(_doneMsg);
					}
				}
			}

			async function runBulkScriptWithGate(source) {
				const operationCanvas = canvasState.currentCanvas;
				const operationRecords = canvasState.bulkRecords;
				const canCommit = () =>
					operationCanvas === canvasState.currentCanvas &&
					operationRecords === canvasState.bulkRecords &&
					(!deps.canCommit || deps.canCommit());
				const runButton = bulkScriptModal.querySelector('#bs-run');
				const output = bulkScriptModal.querySelector('#bs-output');
				if (runButton.disabled) {
					return;
				}
				runButton.disabled = true;
				runButton.textContent = 'Checking access\u2026';
				let accessDenied = false;
				try {
					const response = await csrfFetch('/api/capabilities/run-script/check', {
						method: 'POST',
						credentials: 'same-origin',
					});
					const body = await response.json().catch(() => ({}));
					if (!response.ok) {
						accessDenied = response.status === 403;
						const message =
							(body && (body.message || body.error)) ||
							'Org Loom could not verify your Run script permission.';
						_bsRender(output, 'error', message + ' No changes were applied.');
						if (accessDenied) {
							await Promise.resolve(refreshCapabilities()).catch(() => {});
						}
						return;
					}
				} catch (error) {
					_bsRender(
						output,
						'error',
						'Org Loom could not verify your Run script permission. No changes were applied. Try again.',
					);
					return;
				} finally {
					runButton.textContent = 'Run';
					if (!accessDenied) {
						runButton.disabled = false;
					}
				}

				const loadedCount = _bsScriptableRecords().filter((r) => r.loadedFromId).length;
				if (loadedCount > 0) {
					const ok = await showConfirmDialog({
						title: 'Run script on ' + loadedCount + ' loaded record' + (loadedCount === 1 ? '' : 's') + '?',
						message:
							'This script will modify ' +
							loadedCount +
							' record' +
							(loadedCount === 1 ? '' : 's') +
							' that map' +
							(loadedCount === 1 ? 's' : '') +
							' to existing Salesforce rows. ' +
							'Edits run locally; your next Upload is what would push them to Salesforce. Make sure you trust this script before running.',
						confirmLabel: 'Run script',
						cancelLabel: 'Cancel',
						danger: true,
					});
					if (!ok) {
						return;
					}
				}
				if (!canCommit()) {
					_bsRender(
						output,
						'error',
						'The canvas or editing session changed. Reopen Run script. No changes were applied.',
					);
					return;
				}
				runBulkScript(source);
			}

			bulkScriptModal.querySelector('#bs-run').onclick = () => {
				const ta = bulkScriptModal.querySelector('#bs-source');
				runBulkScriptWithGate(ta.value);
			};
			bulkScriptModal.querySelector('#bs-source').addEventListener('keydown', (e) => {
				if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
					e.preventDefault();
					runBulkScriptWithGate(e.currentTarget.value);
				}
			});

			return {
				openModal: openBulkScriptModal,
			};
		},
	};
})();
