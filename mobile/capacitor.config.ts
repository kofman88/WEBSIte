import type { CapacitorConfig } from '@capacitor/cli';

/**
 * CHM Finance — Capacitor wrapper.
 *
 * Two deploy modes, toggled by CHM_MOBILE_MODE:
 *   "remote"  (default) — WebView loads https://chmup.top directly; www/
 *                         only holds a bootstrap splash. Fastest path to
 *                         Google Play / App Store, no rebuild per release.
 *   "bundle"            — Copies /frontend into www/ at build time; app
 *                         can run offline against a cached shell. Heavier,
 *                         slower to deploy new UI.
 *
 * Switch with: CHM_MOBILE_MODE=bundle npm run sync
 */

const MODE = process.env.CHM_MOBILE_MODE || 'remote';
const REMOTE_URL = process.env.CHM_MOBILE_URL || 'https://chmup.top';

const baseConfig: CapacitorConfig = {
  appId: 'top.chmup.app',
  appName: 'CHM Finance',
  webDir: 'www',

  // Allow the WebView to talk to our API over HTTPS (default), plus cleartext
  // localhost for dev/simulator debugging. Do NOT enable allowNavigation for
  // arbitrary origins — keep user inside our domain.
  server: MODE === 'remote'
    ? { url: REMOTE_URL, cleartext: false, androidScheme: 'https' }
    : { androidScheme: 'https' },

  android: {
    backgroundColor: '#0A0A0A',
    allowMixedContent: false,
    webContentsDebuggingEnabled: process.env.NODE_ENV !== 'production',
  },
  ios: {
    contentInset: 'never',
    backgroundColor: '#0A0A0A',
    scrollEnabled: true,
    limitsNavigationsToAppBoundDomains: false,
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 800,
      backgroundColor: '#0A0A0A',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0A0A0A',
      overlaysWebView: false,
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default baseConfig;
