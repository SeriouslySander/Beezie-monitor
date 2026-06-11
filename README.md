# Beezie claw-monitor

Onchain +EV-detector voor Beezie claw-machines op Base. Stuurt Telegram-alerts bij:
EV-flip (machine wordt +EV), grail getrokken, endgame (pool < 45% met grails erin),
en nieuwe machines via de factory.

## Setup vanaf je iPhone (10 min)

1. **Telegram-bot**: stuur /newbot naar @BotFather, kopieer de token.
   Stuur je nieuwe bot een berichtje en haal je chat-ID op via @userinfobot.
2. **RPC-key**: maak gratis een account op alchemy.com, nieuwe app op Base Mainnet,
   kopieer de HTTPS-URL.
3. **GitHub**: maak een nieuwe repo en upload de inhoud van deze map
   (Add file -> Upload files).
4. **Railway**: railway.app -> New Project -> Deploy from GitHub repo.
5. **Variables** in Railway:
   - TELEGRAM_BOT_TOKEN
   - TELEGRAM_CHAT_ID
   - BASE_RPC_URL
6. Deploy start automatisch. Alerts komen binnen op Telegram.

## Knoppen (bovenin beezie-claw-monitor.js, in CONFIG)

- evAlertUsd: drempel voor de +EV-alert (0 = breakeven)
- grailTopN: hoeveel topkaarten per machine als grail gevolgd worden (5)
- endgamePoolFrac: endgame-alert als pool onder dit deel van de start zakt (0.45)
- pollSlowMs / pollFastMs: poll-tempo koud/warm
