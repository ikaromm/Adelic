// Limits and type rules for chat attachments, shared by the composer and the server.
// The server re-checks everything (magic bytes for images, UTF-8 for text): the client
// checks only to fail fast with the same messages.

export const MAX_ATTACHMENTS_PER_MESSAGE = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_BYTES = 512 * 1024;
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;
export type ImageMime = (typeof IMAGE_MIMES)[number];

const TEXT_EXTENSIONS = new Set(
  (
    'txt text md markdown rst adoc json jsonc json5 yaml yml toml ini cfg conf properties csv tsv log xml ' +
    'html htm css scss sass less js mjs cjs jsx ts tsx mts cts py pyi rb go rs java kt kts swift c h cc cpp ' +
    'cxx hpp hh cs php sh bash zsh fish ps1 sql graphql gql proto vue svelte lua r dart scala ex exs erl hs ' +
    'ml clj el vim tf hcl nix gradle diff patch tex'
  ).split(' '),
);
const TEXT_BASENAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'gemfile', 'procfile']);
const IMAGE_EXTENSIONS: Record<string, ImageMime> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

export type AttachmentKind = 'image' | 'text';
export type AttachmentCheck = { ok: true; kind: AttachmentKind; mime: string } | { ok: false; message: string };

const extension = (name: string) => {
  const base = name.split(/[\\/]/).at(-1) ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : '';
};
const basename = (name: string) => (name.split(/[\\/]/).at(-1) ?? '').toLowerCase();

/** "1,5 MB" (en "1.5 MB"), "12 KB", "300 B". */
export const formatBytes = (bytes: number, locale: 'pt-BR' | 'en' = 'pt-BR') =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1).replace('.', locale === 'en' ? '.' : ',')} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;

/** Decides whether a file can be attached from its name, declared type and size. */
export function checkAttachment(name: string, mime: string, size: number): AttachmentCheck {
  const ext = extension(name);
  const declared = mime.toLowerCase();
  const image = (IMAGE_MIMES as readonly string[]).includes(declared) ? (declared as ImageMime) : IMAGE_EXTENSIONS[ext];
  if (image) {
    if (size > MAX_IMAGE_BYTES) return { ok: false, message: `“${name}” passa de 10 MB, o limite para imagens.` };
    return { ok: true, kind: 'image', mime: image };
  }
  if (declared.startsWith('image/'))
    return { ok: false, message: `“${name}”: só são aceitas imagens PNG, JPEG, WebP ou GIF.` };
  if (TEXT_EXTENSIONS.has(ext) || TEXT_BASENAMES.has(basename(name)) || (!ext && declared.startsWith('text/'))) {
    if (size > MAX_TEXT_BYTES)
      return { ok: false, message: `“${name}” passa de 512 KB, o limite para arquivos de texto.` };
    return { ok: true, kind: 'text', mime: 'text/plain' };
  }
  return {
    ok: false,
    message: `“${name}” não é um tipo aceito. Anexe imagens (PNG, JPEG, WebP, GIF) ou arquivos de texto e código.`,
  };
}

/** Image type from the first bytes; undefined when the content is not one of the accepted formats. */
export function sniffImage(bytes: Uint8Array): ImageMime | undefined {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return 'image/webp';
  return undefined;
}
