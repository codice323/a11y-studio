import React from 'react';
import {createRoot} from 'react-dom/client';
import {Campus, pageFromPath} from './campus';
import './campus.css';
createRoot(document.getElementById('root')!).render(<Campus initial={pageFromPath(location.pathname)} />);
