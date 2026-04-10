import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import App from './App.vue'
import router from './router'
import { installTwemojiDirective } from './directives/twemoji'
import { startEmojiPrewarm } from './utils/emojiPrewarm'

const app = createApp(App)

app.use(createPinia())
app.use(router)
installTwemojiDirective(app)
app.mount('#app')

window.setTimeout(() => {
  window.requestAnimationFrame(() => {
    startEmojiPrewarm()
  })
}, 0)
