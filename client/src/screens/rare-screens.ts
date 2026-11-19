// Экраны вне начального JS одним отдельным чанком (бюджет, `bundle-budget.json`): поиск, каталог MusicBrainz (артист и
// альбом из поиска), источники альбома. Один чанк, а не по чанку на экран: каждый новый динамический чанк заставляет
// сборщик выносить общие модули в ещё один предзагружаемый чанк — и начальный JS растёт. Оболочка загружает чанк сразу
// после старта, чтобы переходы на эти экраны не ждали кода.
export { SourcesScreen } from './library/sources';
export { SearchScreen } from './search';
export { CatalogAlbumScreen, CatalogArtistScreen } from './catalog';
export { preloadCatalog } from '@/lib/search/catalog';
