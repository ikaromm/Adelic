import { defineMessages } from '../../../shared/i18n.js';

// Upload checks (server/attachments.ts, and the shared/attachments.ts refusals the API repeats).
// Keep pt-BR byte-identical: the composer shows the same text from shared/attachments.ts.
export default defineMessages(
  {
    'attachments.empty': '“{name}” está vazio.',
    'attachments.notImage': '“{name}” não é uma imagem PNG, JPEG, WebP ou GIF válida.',
    'attachments.notUtf8': '“{name}” não é texto UTF-8.',
    'attachments.binary': '“{name}” parece ser um arquivo binário.',
    'attachments.imageTooLarge': '“{name}” passa de 10 MB, o limite para imagens.',
    'attachments.imageType': '“{name}”: só são aceitas imagens PNG, JPEG, WebP ou GIF.',
    'attachments.textTooLarge': '“{name}” passa de 512 KB, o limite para arquivos de texto.',
    'attachments.type':
      '“{name}” não é um tipo aceito. Anexe imagens (PNG, JPEG, WebP, GIF) ou arquivos de texto e código.',
    'attachments.unavailable': 'Anexo “{name}” não está mais disponível',
  },
  {
    'attachments.empty': '“{name}” is empty.',
    'attachments.notImage': '“{name}” is not a valid PNG, JPEG, WebP or GIF image.',
    'attachments.notUtf8': '“{name}” is not UTF-8 text.',
    'attachments.binary': '“{name}” looks like a binary file.',
    'attachments.imageTooLarge': '“{name}” is over 10 MB, the limit for images.',
    'attachments.imageType': '“{name}”: only PNG, JPEG, WebP or GIF images are accepted.',
    'attachments.textTooLarge': '“{name}” is over 512 KB, the limit for text files.',
    'attachments.type':
      '“{name}” is not an accepted type. Attach images (PNG, JPEG, WebP, GIF) or text and code files.',
    'attachments.unavailable': 'Attachment “{name}” is no longer available',
  },
);
