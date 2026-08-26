interface MainWindowLike {
  isDestroyed(): boolean;
  webContents: {
    id: number;
    isDestroyed(): boolean;
  };
}

/** IPC is intentionally bound to the one product window, never any auxiliary window. */
export const isTrustedMainWindowSender = (
  mainWindow: MainWindowLike | null,
  webContentsId: number,
): boolean => mainWindow !== null
  && !mainWindow.isDestroyed()
  && !mainWindow.webContents.isDestroyed()
  && mainWindow.webContents.id === webContentsId;
