// Редкие экраны одним отдельным чанком (бюджет начального JS, `bundle-budget.json`): источники альбома и каталог
// MusicBrainz (артист и альбом из поиска). Один чанк, а не по чанку на экран: каждый новый динамический чанк
// заставляет сборщик выносить общие модули в ещё один предзагружаемый чанк — и начальный JS растёт.
export { SourcesScreen } from './library/sources';
export { CatalogAlbumScreen, CatalogArtistScreen } from './catalog';
