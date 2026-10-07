// Merged UI catalogs and the plain `t()` (docs/i18n.md). Safe to import from any module.
import { Fragment, createElement, type ReactNode } from 'react';
import {
  interpolateParts,
  mergeAreas,
  template,
  translate,
  type Locale,
  type PluralBase,
  type Vars,
} from '../../shared/i18n';
import * as areas from './messages';
import { getLocale } from './store';

type Areas = typeof areas;
type CatalogKey = { [A in keyof Areas]: keyof Areas[A]['pt-BR'] & string }[keyof Areas];
/** Every message key, plus the base name of plural keys (`x` for `x.one` / `x.other`). */
export type MessageKey = CatalogKey | PluralBase<CatalogKey>;

export const catalogs = mergeAreas(areas);

/** Translates `key` in the current locale (or `locale`). `{name}` takes vars.name; `count` picks plurals. */
export function t(key: MessageKey, vars?: Vars, locale: Locale = getLocale()): string {
  return translate(catalogs, locale, key, vars);
}

/** Rich interpolation: vars may be React nodes (e.g. `<strong>`); render the returned array. */
export function tRich(key: MessageKey, vars: Record<string, ReactNode>, locale: Locale = getLocale()): ReactNode[] {
  const count = typeof vars.count === 'number' ? { count: vars.count } : undefined;
  return interpolateParts(template(catalogs, locale, key, count), vars).map((part, index) =>
    typeof part === 'string' ? part : createElement(Fragment, { key: index }, part),
  );
}
