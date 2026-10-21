import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';

function language(path) {
  const extension = String(path || '').split('.').pop().toLowerCase();
  if (extension === 'py' || extension === 'pyi') return python();
  if (['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'].includes(extension)) return javascript({ typescript: ['ts', 'tsx'].includes(extension), jsx: ['jsx', 'tsx'].includes(extension) });
  if (['json', 'jsonc'].includes(extension)) return json();
  if (['md', 'markdown'].includes(extension)) return markdown();
  return [];
}

export function createEditor(parent, options = {}) {
  const syntax = new Compartment();
  const editable = new Compartment();
  let path = options.path || '';
  let readOnly = !!options.readOnly;
  let destroyed = false;
  const permission = () => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
  const extensions = [
    keymap.of([{ key: 'Mod-s', preventDefault: true, run() { options.onSave?.(); return true; } }, indentWithTab]),
    basicSetup,
    EditorState.tabSize.of(4),
    syntax.of(language(path)), editable.of(permission()),
    EditorView.contentAttributes.of({ 'aria-label': '代码编辑器', spellcheck: 'false', autocapitalize: 'off', autocorrect: 'off' }),
    EditorView.updateListener.of(update => { if (update.docChanged) options.onChange?.(update.state.doc.toString()); }),
    EditorView.theme({
      '&': { height: '100%', fontSize: '13px', backgroundColor: '#ffffff', color: '#334155' },
      '.cm-scroller': { fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace', lineHeight: '1.7', overflow: 'auto' },
      '.cm-content': { padding: '12px 0', minHeight: '100%', caretColor: '#2563eb' },
      '.cm-line': { padding: '0 16px' },
      '.cm-gutters': { backgroundColor: '#f8f9fb', color: '#a0aec0', borderRight: '1px solid #edf0f5', minWidth: '45px' },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 8px' },
      '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: '#f3f6fb' },
      '&.cm-focused': { outline: 'none' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { backgroundColor: '#dce9ff' },
      '.cm-cursor': { borderLeftColor: '#2563eb' },
      '.cm-panels': { fontFamily: 'system-ui, sans-serif', fontSize: '12px', backgroundColor: '#f8f9fb', color: '#475569' },
      '.cm-search input, .cm-search button': { fontSize: '12px', borderRadius: '3px' }
    }),
    EditorState.phrases.of({ Find: '查找', Replace: '替换', next: '下一个', previous: '上一个', all: '全部', 'match case': '区分大小写', regexp: '正则', 'by word': '全词', 'replace all': '全部替换', close: '关闭' })
  ];
  const makeState = doc => EditorState.create({ doc: String(doc ?? ''), extensions });
  const view = new EditorView({ parent, state: makeState(options.doc || '') });
  return {
    getValue() { return view.state.doc.toString(); },
    setValue(value) { if (!destroyed) view.setState(makeState(value)); },
    setReadOnly(value) { readOnly = !!value; if (!destroyed) view.dispatch({ effects: editable.reconfigure(permission()) }); },
    setPath(value) { path = String(value || ''); if (!destroyed) view.dispatch({ effects: syntax.reconfigure(language(path)) }); },
    focus() { if (!destroyed) view.focus(); },
    getState() { return view.state; },
    setState(state) { if (!destroyed) { view.setState(state); view.dispatch({ effects: [editable.reconfigure(permission()), syntax.reconfigure(language(path))] }); } },
    destroy() { if (!destroyed) { destroyed = true; view.destroy(); } }
  };
}
