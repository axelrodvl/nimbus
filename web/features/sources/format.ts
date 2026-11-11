export function formatSize(bytes: number | null | undefined): string {
  if (bytes == null) return '—';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const SOURCE_LABEL: Record<string, string> = {
  manual: 'Свой',
  rutracker: 'RuTracker',
  torznab: 'Torznab',
  tpb: 'TPB',
};

export const KIND_LABEL: Record<string, string> = {
  album: 'Альбом',
  discography: 'Дискография',
  single: 'Сингл',
  unknown: '—',
};

export const META_LABEL: Record<string, string> = {
  dead: 'Мёртвая',
  error: 'Ошибка',
  fetching: 'Загрузка метаданных…',
  ok: 'Метаданные получены',
  pending: 'Ожидает',
  timeout: 'Нет ответа',
};
