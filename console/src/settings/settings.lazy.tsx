import { createLazyRoute } from '@tanstack/react-router';
import { SettingsPage } from './SettingsPage.js';
import './settings.css';
export const IndexRoute = createLazyRoute('/settings')({ component: SettingsPage });
export const PageRoute = createLazyRoute('/settings/$page')({ component: SettingsPage });
