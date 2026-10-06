import { useState, type FormEvent } from 'react';
import { Brain, FolderPlus, LoaderCircle, Plus, Shield, X } from 'lucide-react';

/** Lowercase ASCII slug used as the default memory project id. */
export function projectSlug(name: string) {
  return name
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

export interface NewProject {
  name: string;
  path: string;
  memoryWorkspace: string;
  memoryProject: string;
}

/** "Novo projeto" dialog. Owns its fields; the caller creates the project and closes it. */
export function ProjectForm({
  busy,
  error,
  onSubmit,
  onClose,
}: {
  busy: boolean;
  error: string;
  onSubmit: (project: NewProject) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [memoryWorkspace, setMemoryWorkspace] = useState('pessoal');
  const [memoryProject, setMemoryProject] = useState('');
  // The memory id follows the name until the user edits it.
  const [customId, setCustomId] = useState(false);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit({
      name: name.trim(),
      path: path.trim(),
      memoryWorkspace: memoryWorkspace.trim(),
      memoryProject: memoryProject.trim() || projectSlug(name),
    });
  };
  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <form
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-form-title"
        onSubmit={submit}
      >
        <div className="modal-heading">
          <div className="project-avatar" aria-hidden="true">
            <FolderPlus size={17} />
          </div>
          <div>
            <h2 id="project-form-title">Novo projeto</h2>
            <p>Conecte uma pasta do seu computador.</p>
          </div>
          <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}>
            <X size={17} />
          </button>
        </div>
        <label>
          Nome do projeto
          <input
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (!customId) setMemoryProject(projectSlug(event.target.value));
            }}
            placeholder="Ex.: Meu aplicativo"
            required
          />
        </label>
        <label>
          Caminho da pasta
          <input
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="/home/voce/projetos/app"
            required
          />
        </label>
        <div className="memory-scope-modal">
          <div>
            <Brain size={14} /> Escopo de memória explícito
          </div>
          <label>
            Workspace
            <input
              value={memoryWorkspace}
              onChange={(event) => setMemoryWorkspace(event.target.value)}
              placeholder="pessoal"
              required
            />
          </label>
          <label>
            Projeto na memória
            <input
              value={memoryProject}
              onChange={(event) => {
                setMemoryProject(event.target.value);
                setCustomId(true);
              }}
              placeholder="identificador único"
              required
            />
          </label>
          <small>O identificador começa pelo nome do projeto e pode ser ajustado.</small>
        </div>
        <div className="modal-note">
          <Shield size={14} /> O agente usará esta pasta conforme a permissão definida.
        </div>
        {error && <div className="form-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>
            Cancelar
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !name.trim() || !path.trim() || !memoryWorkspace.trim() || !memoryProject.trim()}
          >
            {busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />} Criar projeto
          </button>
        </div>
      </form>
    </div>
  );
}
