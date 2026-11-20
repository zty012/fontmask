import { createEffect, createMemo, createSignal, For, onCleanup, Show } from 'solid-js';
import { render } from 'solid-js/web';
import { ArrowDownToLine, ArrowRight, ArrowLeftRight, Check, CircleAlert, FileType2, Layers2, LockKeyhole, Moon, Plus, Sun, Type, Upload, X } from 'lucide-solid';
import { zip } from 'fflate';
import FontWorker from './worker.js?worker';
import './style.css';

const modes = [{ value: 'identity', label: '替换字体身份' }, { value: 'glyphs', label: '替换字形' }];
const outputName = (file, result) => `${file.name.replace(/\.(ttf|ttc)$/i, '')}.${result.isCollection ? 'ttc' : 'ttf'}`;
const formatSize = (size) => size < 1048576 ? `${Math.max(1, Math.round(size / 1024))} KB` : `${(size / 1048576).toFixed(1)} MB`;

function download(bytes, name) {
  const url = URL.createObjectURL(new Blob([bytes]));
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

function ThemeToggle() {
  const root = document.documentElement;
  const system = matchMedia('(prefers-color-scheme: dark)');
  const [systemDark, setSystemDark] = createSignal(system.matches);
  const [theme, setTheme] = createSignal(root.dataset.theme);
  const dark = () => theme() ? theme() === 'dark' : systemDark();
  const syncSystem = (event) => setSystemDark(event.matches);
  system.addEventListener('change', syncSystem);
  onCleanup(() => system.removeEventListener('change', syncSystem));

  createEffect(() => {
    document.querySelector('meta[name="theme-color"]').content = dark() ? '#141816' : '#f6f7f4';
  });

  function toggle() {
    const next = dark() ? 'light' : 'dark';
    root.dataset.theme = next;
    setTheme(next);
    try { localStorage.setItem('fontmask-theme', next); } catch {}
  }

  return <button type="button" class="theme-toggle" aria-label="深色模式" aria-pressed={dark()} title={dark() ? '切换浅色模式' : '切换深色模式'} onClick={toggle}>
    <Show when={dark()} fallback={<Moon size={17} aria-hidden="true" />}><Sun size={17} aria-hidden="true" /></Show>
  </button>;
}

function UploadPanel(props) {
  const [dragging, setDragging] = createSignal(false);
  let input;
  return <section class="upload-panel" aria-label={props.title}>
    <div class="panel-title flex items-center gap-3">
      <div class="role-icon" classList={{ donor: props.donor }}><Show when={props.donor} fallback={<Type size={20} />}><Layers2 size={20} /></Show></div>
      <div class="grow"><h3>{props.title}</h3><p>{props.label}</p></div>
      <span class="technical">{props.donor ? '02' : '01'}</span>
    </div>
    <input ref={input} type="file" aria-label={`添加${props.title}`} accept=".ttf,.ttc" multiple hidden onChange={(event) => {
      props.onAdd([...event.currentTarget.files]);
      event.currentTarget.value = '';
    }} />
    <button type="button" class="dropzone" classList={{ dragging: dragging(), compact: props.files.length > 0 }} disabled={props.busy}
      onClick={() => input.click()}
      onDragOver={(event) => { event.preventDefault(); if (!props.busy) setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      onDrop={(event) => {
        event.preventDefault(); setDragging(false);
        if (!props.busy) props.onAdd([...event.dataTransfer.files]);
      }}>
      <Show when={!props.files.length} fallback={<><Plus size={16} /> 添加更多文件</>}>
        <span class="upload-icon"><Upload size={20} /></span>
        <strong>点击上传<span> 或拖放文件</span></strong>
        <span class="format">TTF / TTC · 可多选</span>
      </Show>
    </button>
    <Show when={props.files.length}>
      <ol class="file-list">
        <For each={props.files}>{(file, index) => <li class="flex items-center gap-2">
          <span class="technical">{String(index() + 1).padStart(2, '0')}</span><FileType2 size={16} />
          <div class="grow min-w-0"><span class="block truncate" title={file.name}>{file.name}</span>
            <Show when={props.status(file)?.info?.variableFaces.some(Boolean)}><span class="format">含可变字面</span></Show>
            <Show when={props.status(file)?.error}><span class="file-error" role="status">{props.status(file).error}</span></Show>
          </div>
          <span class="format shrink-0">{props.status(file)?.info?.isCollection ? `${props.status(file).info.faces.length} 个字面 · ` : ''}{formatSize(file.size)}</span>
          <button class="icon-button" disabled={props.busy} onClick={() => props.onRemove(index())} title={`移除 ${file.name}`} aria-label={`移除 ${file.name}`}><X size={16} /></button>
        </li>}</For>
      </ol>
    </Show>
  </section>;
}

function FaceMappings(props) {
  return <section class="mapping-section" aria-labelledby="mapping-title">
    <div class="section-line flex items-center justify-between gap-3">
      <h2 id="mapping-title"><ArrowLeftRight size={17} /> 字面配对</h2>
      <span class="technical" aria-live="polite">{props.assigned} / {props.total}</span>
    </div>
    <For each={props.bases}>{(file, fileIndex) => <fieldset class="mapping-group" disabled={props.busy}>
      <legend>{file.name}</legend>
      <For each={props.info(file)?.faces}>{(name, faceIndex) => <label class="mapping-row">
        <span><span class="technical">{String(faceIndex() + 1).padStart(2, '0')}</span> {name}</span>
        <ArrowRight size={16} aria-hidden="true" />
        <select aria-label={`${file.name} · ${name}（${faceIndex() + 1}）的供体`} onChange={(event) => {
          const option = props.donorOptions.find(({ key }) => key === event.currentTarget.value);
          props.onChoose(file, faceIndex(), option);
        }}>
          <option value="" disabled selected={!props.mappings[fileIndex()]?.[faceIndex()]}>选择供体字面</option>
          <For each={props.donorOptions}>{(choice) => <option value={choice.key} selected={props.mappings[fileIndex()]?.[faceIndex()]?.key === choice.key}>{choice.label}</option>}</For>
        </select>
      </label>}</For>
    </fieldset>}</For>
  </section>;
}

function App() {
  const [mode, setMode] = createSignal('identity');
  const [bases, setBases] = createSignal([]);
  const [donors, setDonors] = createSignal([]);
  const [entries, setEntries] = createSignal([]);
  const [inventory, setInventory] = createSignal(new Map());
  const [choices, setChoices] = createSignal(new Map());
  const [busy, setBusy] = createSignal(false);
  const [zipping, setZipping] = createSignal(false);
  const [notice, setNotice] = createSignal('');
  const identity = () => mode() === 'identity';
  const success = createMemo(() => entries().filter(({ result }) => result));
  const files = createMemo(() => [...bases(), ...donors()]);
  const status = (file) => inventory().get(file);
  const info = (file) => status(file)?.info;
  const scanning = () => files().some((file) => !status(file)?.error && !info(file));
  const invalid = () => files().some((file) => status(file)?.error);
  const collection = () => files().some((file) => info(file)?.isCollection);
  const mismatch = () => !collection() && bases().length && donors().length > 1 && donors().length !== bases().length;
  const donorOptions = createMemo(() => donors().flatMap((file, fileIndex) => info(file)?.faces.map((name, faceIndex) => ({
    file, fileIndex, faceIndex, key: `${fileIndex}:${faceIndex}`,
    label: info(file).isCollection ? `${file.name} · ${faceIndex + 1}. ${name}` : file.name,
  })) ?? []));
  const mappings = createMemo(() => bases().map((file, index) => (info(file)?.faces ?? []).map((_, faceIndex) => {
    if (!collection()) return donorOptions()[donors().length === 1 ? 0 : index];
    const choice = choices().get(file)?.[faceIndex];
    return donorOptions().find((option) => option.file === choice?.file && option.faceIndex === choice.faceIndex)
      ?? (donorOptions().length === 1 ? donorOptions()[0] : undefined);
  })));
  const total = () => mappings().reduce((count, mapping) => count + mapping.length, 0);
  const assigned = () => mappings().reduce((count, mapping) => count + mapping.filter(Boolean).length, 0);
  const canMap = () => collection() && bases().length > 0 && donors().length > 0 && !scanning() && !invalid();
  const variableBase = () => !identity() && bases().some((file) => info(file)?.variableFaces.some(Boolean));
  const ready = () => !busy() && !zipping() && !scanning() && !invalid() && !mismatch() && !variableBase() && total() > 0 && assigned() === total();
  const inspectors = new Set();
  let worker;
  onCleanup(() => {
    worker?.terminate();
    for (const inspector of inspectors) inspector.terminate();
  });

  function clearResults() {
    setEntries([]); setNotice('');
  }

  function inspect(added) {
    let inspector;
    function finish() {
      inspector?.terminate();
      inspectors.delete(inspector);
    }
    function fail() {
      finish();
      setInventory((previous) => {
        const next = new Map(previous);
        for (const file of added) if (next.has(file) && !next.get(file)) next.set(file, { error: '无法读取字体，请重新添加。' });
        return next;
      });
    }
    try {
      inspector = new FontWorker();
      inspectors.add(inspector);
      inspector.onmessage = ({ data }) => {
        if (data.done) return finish();
        const file = added[data.index];
        setInventory((previous) => previous.has(file) ? new Map(previous).set(file, data) : previous);
      };
      inspector.onerror = fail;
      inspector.postMessage({ inspect: added });
    } catch {
      fail();
    }
  }

  function add(setFiles, files) {
    const valid = files.filter((file) => /\.(ttf|ttc)$/i.test(file.name));
    if (valid.length) {
      clearResults();
      setInventory((previous) => new Map([...previous, ...valid.map((file) => [file, undefined])]));
      setFiles((previous) => [...previous, ...valid]);
      inspect(valid);
    }
    if (valid.length !== files.length) setNotice('已跳过非 TTF / TTC 文件。');
  }

  function remove(setFiles, index, file) {
    clearResults();
    setFiles((files) => files.filter((_, fileIndex) => fileIndex !== index));
    setInventory((previous) => {
      const next = new Map(previous);
      next.delete(file);
      return next;
    });
    setChoices((previous) => new Map([...previous].filter(([base]) => base !== file).map(([base, faces]) => [base, faces.map((choice) => choice?.file === file ? undefined : choice)])));
  }

  function choose(file, faceIndex, option) {
    clearResults();
    setChoices((previous) => {
      const faces = [...(previous.get(file) ?? [])];
      faces[faceIndex] = option;
      return new Map(previous).set(file, faces);
    });
  }

  function stop() {
    worker?.terminate();
    worker = undefined;
    setBusy(false);
  }

  function start() {
    if (!ready()) return;
    clearResults();
    const files = bases();
    const donorFiles = donors();
    const selectedFaces = mappings().map((mapping) => mapping.map(({ fileIndex, faceIndex }) => ({ fileIndex, faceIndex })));
    const processingMode = mode();
    setBusy(true);
    try {
      worker = new FontWorker();
      worker.onmessage = ({ data }) => {
        if (data.done) return stop();
        const source = processingMode === 'identity' ? donorFiles[selectedFaces[data.index][0].fileIndex] : files[data.index];
        setEntries((previous) => [...previous, { ...data, file: files[data.index], source }]);
      };
      worker.onerror = () => { stop(); setNotice('处理已中断，请尝试分批处理。'); };
      worker.postMessage({ bases: files, donors: donorFiles, mappings: selectedFaces, mode: processingMode });
    } catch {
      stop(); setNotice('无法启动字体处理，请刷新后重试。');
    }
  }

  function downloadAll() {
    const names = new Set();
    const files = Object.fromEntries(success().map(({ file, result }) => {
      const original = outputName(file, result);
      let name = original;
      for (let index = 2; names.has(name.toLowerCase()); index++) name = original.replace(/\.(?=[^.]+$)/, `-${index}.`);
      names.add(name.toLowerCase());
      return [name, result.bytes];
    }));
    setZipping(true);
    zip(files, { level: 0 }, (error, bytes) => {
      setZipping(false);
      if (error) setNotice('无法生成 ZIP，请单独下载字体。');
      else download(bytes, 'fontmask.zip');
    });
  }

  return <>
    <header class="topbar"><div class="shell flex items-center justify-between gap-3">
      <div class="wordmark flex items-center gap-2.5"><span class="brand-icon"><Layers2 size={21} /></span> FontMask</div>
      <div class="flex items-center gap-2"><span class="local-status"><span></span> 本地处理</span><ThemeToggle /></div>
    </div></header>
    <main class="shell workspace">
      <div class="workspace-heading flex flex-wrap items-end justify-between gap-4">
        <div><div class="eyebrow"><span></span> FONT WORKBENCH</div><h1>字体工作台</h1></div>
        <fieldset class="mode-switch" aria-label="处理模式" disabled={busy() || zipping()}>
          <For each={modes}>{(option) => <label>
            <input type="radio" name="processing-mode" value={option.value} checked={mode() === option.value} onChange={() => {
              setMode(option.value);
              clearResults();
            }} />
            <span>{option.label}</span>
          </label>}</For>
        </fieldset>
      </div>
      <div class="section-line flex items-center justify-between gap-3"><h2><FileType2 size={17} /> 字体文件</h2><span class="technical">TTF / TTC</span></div>
      <div class="upload-grid">
        <UploadPanel title="基底字体" label={identity() ? '提供字体名称' : '保留字体名称与字距'} files={bases()} status={status} busy={busy() || zipping()} onAdd={(files) => add(setBases, files)} onRemove={(index) => remove(setBases, index, bases()[index])} />
        <span class="direction" aria-hidden="true"><ArrowRight size={18} /></span>
        <UploadPanel donor title="供体字体" label={identity() ? '保留字形与排版' : '提供替换字形'} files={donors()} status={status} busy={busy() || zipping()} onAdd={(files) => add(setDonors, files)} onRemove={(index) => remove(setDonors, index, donors()[index])} />
      </div>
      <Show when={canMap()}><FaceMappings bases={bases()} info={info} donorOptions={donorOptions()} mappings={mappings()} total={total()} assigned={assigned()} busy={busy() || zipping()} onChoose={choose} /></Show>
      <div class="action-bar flex flex-wrap items-center justify-between gap-3">
        <div class="action-summary" role="status"><ArrowLeftRight size={16} /><span>{scanning() ? '正在读取字体…' : invalid() ? '移除无法读取的字体后继续' : canMap() ? `已配对 ${assigned()} / ${total()} 个字面` : mismatch() ? '供体数量须为 1，或与基底数量相同' : donors().length === 1 ? '共用同一供体' : '按上传顺序配对'}</span></div>
        <div class="flex gap-2">
          <Show when={busy()}><button class="secondary" onClick={stop}>停止</button></Show>
          <button class="primary" disabled={!ready()} onClick={start}>{busy() ? `处理中 ${entries().length}/${bases().length}` : '开始替换'} <ArrowRight size={17} /></button>
        </div>
      </div>
      <Show when={variableBase()}><p role="status" class="notice"><CircleAlert size={16} /> 可变字体作为基底时，请使用「替换字体身份」模式。</p></Show>
      <Show when={notice()}><p role="status" class="notice"><CircleAlert size={16} /> {notice()}</p></Show>
      <Show when={entries().length}>
        <section class="results" aria-labelledby="results-title">
          <div class="section-line flex flex-wrap items-center justify-between gap-2">
            <h2 id="results-title"><Check size={17} /> 处理结果 <span class="technical">{success().length} / {bases().length}</span></h2>
            <Show when={!busy() && success().length > 1}><button class="secondary" disabled={zipping()} onClick={downloadAll}><ArrowDownToLine size={16} /> {zipping() ? '打包中…' : '下载 ZIP'}</button></Show>
          </div>
          <ul class="result-list" aria-live="polite">
            <For each={entries()}>{(entry) => <li class="flex flex-wrap items-center gap-3">
              <div class="result-detail grow min-w-0">
                <strong class="block truncate">{entry.result ? outputName(entry.file, entry.result) : entry.file.name}</strong>
                <p>{entry.error ?? (identity()
                  ? `已移植 ${entry.result.faceCount} 个字面的名称${entry.result.variableCount ? ` · 保留 ${entry.result.variableCount} 个可变字面` : ''}${entry.result.faceCount === 1 ? ` · 供体：${entry.source.name}` : ''}`
                  : `已替换 ${entry.result.replaced} 个字形 · 保留 ${entry.result.kept} 个${entry.result.replaced ? '' : ' · 无匹配字形'}`)}</p>
              </div>
              <Show when={entry.result}>
                <button class="secondary" onClick={() => download(entry.result.bytes, outputName(entry.file, entry.result))}><ArrowDownToLine size={16} /> 下载</button>
              </Show>
            </li>}</For>
          </ul>
        </section>
      </Show>
      <footer class="flex items-center justify-between gap-3"><span class="flex items-center gap-2"><LockKeyhole size={14} /> 文件仅在此浏览器处理</span><span>FontMask / 01</span></footer>
    </main>
  </>;
}

render(() => <App />, document.getElementById('root'));
