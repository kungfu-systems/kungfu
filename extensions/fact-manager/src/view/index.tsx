import type {
  FactMaterialInput,
  FactTypeDefinition,
  StorageValue,
} from '@kungfu-tech/api/capability';
import type { KfxCapabilities, Shell } from '@kungfu-tech/kfx';
import { headingStyle, inputStyle, mono, panelStyle } from '@kungfu-tech/kfx';
import React from 'react';

type FactTypeRow = {
  id: string;
  version: string;
  root: string;
  schema_owner_root: string;
  source_authorities: string[];
  episode_id: number;
};

type HistoryRow = {
  observation_id: string;
  action: string;
  outcome: string;
  subject_key: string;
  source_id: string;
  payload_hash: string;
  episode_id: number;
};

const buttonStyle: React.CSSProperties = {
  ...mono,
  padding: '5px 10px',
  border: '1px solid #555',
  borderRadius: 3,
};

const fieldStyle: React.CSSProperties = { ...inputStyle, minWidth: 130 };

function rows(value: unknown): StorageValue[] {
  return Array.isArray(value)
    ? value.filter(
        (item): item is StorageValue =>
          typeof item === 'object' && item !== null,
      )
    : [];
}

function downloadJson(name: string, value: StorageValue) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function FactManagerView({ caps }: { caps: KfxCapabilities; shell: Shell }) {
  const { storage } = caps;
  const [types, setTypes] = React.useState<FactTypeRow[]>([]);
  const [selectedTypeKey, setSelectedTypeKey] = React.useState('');
  const [history, setHistory] = React.useState<HistoryRow[]>([]);
  const [payloads, setPayloads] = React.useState<StorageValue>({});
  const [layout, setLayout] = React.useState<StorageValue>({});
  const [assessmentCount, setAssessmentCount] = React.useState(0);
  const [message, setMessage] = React.useState('');
  const [error, setError] = React.useState('');

  const [typeId, setTypeId] = React.useState('goal-status');
  const [typeVersion, setTypeVersion] = React.useState('1');
  const [sources, setSources] = React.useState('agent,human');
  const [schemaText, setSchemaText] = React.useState(
    JSON.stringify(
      {
        type: 'object',
        properties: {
          status: { type: 'string' },
          ready_for_handoff: { type: 'boolean' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
        required: ['status', 'ready_for_handoff'],
        additionalProperties: false,
      },
      null,
      2,
    ),
  );
  const [subject, setSubject] = React.useState('current-goal');
  const [source, setSource] = React.useState('agent');
  const [payloadText, setPayloadText] = React.useState(
    JSON.stringify(
      { status: 'in-progress', ready_for_handoff: false, evidence: [] },
      null,
      2,
    ),
  );
  const [pendingImport, setPendingImport] = React.useState<StorageValue | null>(
    null,
  );

  const refresh = React.useCallback(() => {
    try {
      const typeCatalog = storage.factTypes();
      const nextTypes = rows(typeCatalog.fact_types) as FactTypeRow[];
      const nextSelected =
        selectedTypeKey &&
        nextTypes.some(
          (item) => `${item.id}@${item.version}` === selectedTypeKey,
        )
          ? selectedTypeKey
          : nextTypes[0]
            ? `${nextTypes[0].id}@${nextTypes[0].version}`
            : '';
      const selectedRow = nextTypes.find(
        (item) => `${item.id}@${item.version}` === nextSelected,
      );
      const materials = storage.factMaterials(selectedRow?.id ?? '');
      const state = (materials.state ?? {}) as StorageValue;
      const assessmentCatalog = storage.assessments();
      setTypes(nextTypes);
      setSelectedTypeKey(nextSelected);
      setHistory(rows(state.observation_history) as HistoryRow[]);
      setPayloads((materials.payloads ?? {}) as StorageValue);
      setAssessmentCount(Number(assessmentCatalog.assessment_count ?? 0));
      setLayout(storage.layout());
      setError('');
    } catch (cause) {
      setError((cause as Error).message);
    }
  }, [selectedTypeKey, storage]);

  React.useEffect(() => refresh(), [refresh]);

  const createType = () => {
    try {
      const definition: FactTypeDefinition = {
        id: typeId.trim(),
        version: typeVersion.trim(),
        source_authorities: sources
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        schema: JSON.parse(schemaText) as StorageValue,
      };
      const receipt = storage.createFactType(definition);
      setMessage(
        `type ${String(receipt.status)} · ${definition.id}@${definition.version}`,
      );
      setSelectedTypeKey(`${definition.id}@${definition.version}`);
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const addMaterial = () => {
    const type = types.find(
      (item) => `${item.id}@${item.version}` === selectedTypeKey,
    );
    if (!type) return setError('Select or create a fact type first.');
    try {
      const material: FactMaterialInput = {
        type_id: type.id,
        type_version: type.version,
        source_id: source.trim(),
        subject_key: subject.trim(),
        payload: JSON.parse(payloadText) as StorageValue,
      };
      const receipt = storage.putFactMaterial(material);
      setMessage(
        `material ${String(receipt.ok ? 'admitted' : 'recorded')} · ${String(receipt.payload_hash)}`,
      );
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const exportLibrary = (thin: boolean) => {
    try {
      const bundle = storage.exportFactLibrary(thin);
      downloadJson(`kungfu-facts-${thin ? 'thin' : 'full'}.json`, bundle);
      setMessage(
        `${thin ? 'thin' : 'full'} bundle ready · ${String(bundle.episode_count)} Episodes`,
      );
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  const readImport = async (file: File | undefined) => {
    if (!file) return;
    try {
      const value = JSON.parse(await file.text()) as StorageValue;
      const receipt = storage.importFactLibrary(value);
      if (receipt.ok !== true) throw new Error(JSON.stringify(receipt));
      setPendingImport(value);
      setMessage(
        `verified ${String(receipt.receipt_count)} Episodes; review then import`,
      );
    } catch (cause) {
      setPendingImport(null);
      setError((cause as Error).message);
    }
  };

  const executeImport = () => {
    if (!pendingImport) return;
    if (
      !window.confirm(
        'Append this verified Fact Library to the selected data root?',
      )
    )
      return;
    try {
      const receipt = storage.importFactLibrary(pendingImport, {
        execute: true,
      });
      if (receipt.ok !== true) throw new Error(JSON.stringify(receipt));
      setPendingImport(null);
      setMessage(`imported ${String(receipt.receipt_count)} Episodes`);
      refresh();
    } catch (cause) {
      setError((cause as Error).message);
    }
  };

  return (
    <section style={{ ...panelStyle, height: '100%', overflow: 'auto' }}>
      <h2 style={headingStyle}>Fact Manager</h2>
      <div style={{ ...mono, color: '#858585', marginBottom: 10 }}>
        data root:{' '}
        {String(layout.runtime_home ?? layout.runtime_dir ?? 'unknown')} ·{' '}
        {types.length} types · {history.length} history records ·{' '}
        {assessmentCount} assessments
      </div>
      {message && <div style={{ ...mono, color: '#4ec9b0' }}>{message}</div>}
      {error && <div style={{ ...mono, color: '#f48771' }}>{error}</div>}

      <h3 style={mono}>Create a reusable type · declared-facts-v1</h3>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <input
          value={typeId}
          onChange={(e) => setTypeId(e.target.value)}
          style={fieldStyle}
          placeholder="type id"
        />
        <input
          value={typeVersion}
          onChange={(e) => setTypeVersion(e.target.value)}
          style={{ ...fieldStyle, width: 70 }}
          placeholder="version"
        />
        <input
          value={sources}
          onChange={(e) => setSources(e.target.value)}
          style={{ ...fieldStyle, flex: 1 }}
          placeholder="authorized sources"
        />
        <button type="button" onClick={createType} style={buttonStyle}>
          create / recover
        </button>
      </div>
      <textarea
        value={schemaText}
        onChange={(e) => setSchemaText(e.target.value)}
        rows={7}
        style={{ ...fieldStyle, width: '100%', fontFamily: 'monospace' }}
      />

      <h3 style={mono}>Fact material</h3>
      <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
        <select
          value={selectedTypeKey}
          onChange={(e) => setSelectedTypeKey(e.target.value)}
          style={fieldStyle}
        >
          <option value="">select type</option>
          {types.map((type) => (
            <option
              key={`${type.id}@${type.version}`}
              value={`${type.id}@${type.version}`}
            >
              {type.id}@{type.version}
            </option>
          ))}
        </select>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          style={fieldStyle}
          placeholder="subject"
        />
        <input
          value={source}
          onChange={(e) => setSource(e.target.value)}
          style={fieldStyle}
          placeholder="source"
        />
        <button type="button" onClick={addMaterial} style={buttonStyle}>
          add material
        </button>
      </div>
      <textarea
        value={payloadText}
        onChange={(e) => setPayloadText(e.target.value)}
        rows={6}
        style={{ ...fieldStyle, width: '100%', fontFamily: 'monospace' }}
      />

      <h3 style={mono}>History and current content</h3>
      <table style={{ ...mono, width: '100%', borderCollapse: 'collapse' }}>
        <tbody>
          {history.map((row) => (
            <tr
              key={row.observation_id}
              style={{ borderTop: '1px solid #3c3c3c' }}
            >
              <td style={{ padding: 5 }}>
                {row.action} · {row.outcome}
              </td>
              <td style={{ padding: 5 }}>{row.subject_key}</td>
              <td style={{ padding: 5 }}>{row.source_id}</td>
              <td
                style={{
                  padding: 5,
                  maxWidth: 420,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={JSON.stringify(payloads[row.payload_hash])}
              >
                {JSON.stringify(payloads[row.payload_hash])}
              </td>
            </tr>
          ))}
          {history.length === 0 && (
            <tr>
              <td style={{ padding: 8, color: '#858585' }}>
                No material in this type.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 style={mono}>Move or preserve this library</h3>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          onClick={() => exportLibrary(false)}
          style={buttonStyle}
        >
          export full
        </button>
        <button
          type="button"
          onClick={() => exportLibrary(true)}
          style={buttonStyle}
        >
          export thin
        </button>
        <label style={buttonStyle}>
          verify import
          <input
            type="file"
            accept="application/json,.json"
            onChange={(e) => void readImport(e.target.files?.[0])}
            style={{ display: 'none' }}
          />
        </label>
        <button
          type="button"
          disabled={!pendingImport}
          onClick={executeImport}
          style={buttonStyle}
        >
          import verified bundle
        </button>
      </div>
    </section>
  );
}

export const View = FactManagerView;
