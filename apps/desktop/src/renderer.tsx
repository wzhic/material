import React from 'react';
import { createRoot } from 'react-dom/client';
import 'tdesign-react/es/style/index.css';

import { App } from './ui/App';
import './index.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('应用根节点不存在');
}

createRoot(root).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
