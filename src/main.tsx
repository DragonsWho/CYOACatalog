import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material/styles';
import CssBaseline from '@mui/material/CssBaseline';
import theme from './theme';
import App from './App';
import AppErrorBoundary from './components/AppErrorBoundary';
import { initChunkErrorGuard } from './utils/appReload';
import { initAutoUpdate } from './utils/autoUpdate';
import { initPerfFlags } from './utils/perfFlags';
import './index.css';

// Lazy-chunk load failures (site updated under an open tab) and silent self-update to a new build.
// Both installed before first render.
initChunkErrorGuard();
initAutoUpdate();
initPerfFlags();

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);

root.render( 
    <BrowserRouter>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      </ThemeProvider>
    </BrowserRouter> 
);
