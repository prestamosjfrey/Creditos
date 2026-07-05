// Convierte cada tabla marcada con data-datatable en una DataTable (búsqueda,
// orden y paginación), usando simple-datatables (vanilla JS, sin jQuery).
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('table[data-datatable]').forEach((tabla) => {
    new simpleDatatables.DataTable(tabla, {
      perPage: 10,
      // Algunas tablas tienen su propia barra de búsqueda (servidor); en ese
      // caso se marca con data-no-search para no duplicar el buscador.
      searchable: !tabla.hasAttribute('data-no-search'),
      labels: {
        placeholder: 'Buscar...',
        perPage: 'filas por página',
        noRows: 'No se encontraron resultados',
        noResults: 'Ningún resultado coincide con tu búsqueda',
        searchTitle: 'Buscar en la tabla',
        pageTitle: 'Página {page}',
        info: 'Mostrando {start} a {end} de {rows} registros',
      },
    });
  });
});
