import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';
import './fun.css';
import './today.css';
import { applyStoredLook } from './look';

applyStoredLook();

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
