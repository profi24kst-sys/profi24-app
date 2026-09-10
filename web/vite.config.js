import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function pwaMetadata(){
  return {
    name:'profi24-pwa-metadata',
    transformIndexHtml(html,ctx){
      if(ctx?.path && ctx.path!=='/' && ctx.path!=='/index.html') return html;
      return {
        html,
        tags:[
          {tag:'meta',attrs:{name:'theme-color',content:'#111827'},injectTo:'head'},
          {tag:'meta',attrs:{name:'mobile-web-app-capable',content:'yes'},injectTo:'head'},
          {tag:'meta',attrs:{name:'apple-mobile-web-app-capable',content:'yes'},injectTo:'head'},
          {tag:'meta',attrs:{name:'apple-mobile-web-app-status-bar-style',content:'default'},injectTo:'head'},
          {tag:'meta',attrs:{name:'apple-mobile-web-app-title',content:'PROFI24'},injectTo:'head'},
          {tag:'link',attrs:{rel:'manifest',href:'/manifest.webmanifest'},injectTo:'head'},
          {tag:'link',attrs:{rel:'icon',href:'/icons/profi24.svg',type:'image/svg+xml'},injectTo:'head'},
          {tag:'link',attrs:{rel:'apple-touch-icon',href:'/icons/profi24-192.png'},injectTo:'head'},
          {tag:'link',attrs:{rel:'stylesheet',href:'/pwa-install.css'},injectTo:'head'},
          {tag:'script',attrs:{type:'module',src:'/pwa-install.js'},injectTo:'body'}
        ]
      };
    }
  };
}

export default defineConfig({
  plugins: [react(),pwaMetadata()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        approve: 'approve.html',
        warranty: 'warranty.html',
        feedback: 'feedback.html',
        visit: 'visit.html'
      }
    }
  }
});
