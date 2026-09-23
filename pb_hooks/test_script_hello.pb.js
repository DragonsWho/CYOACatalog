onBootstrap((e) => {
  console.log("JS hook 'onBootstrap' ran.");

  // onBootstrap handlers must call e.next() or the app won't finish booting.
  e.next();
});