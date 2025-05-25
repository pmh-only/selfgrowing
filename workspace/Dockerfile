FROM alpine
WORKDIR /app/

RUN apk add --no-cache nodejs pnpm

COPY package.json  .

RUN pnpm i

COPY main.js  .

ENTRYPOINT [ "node", "/app/main.mjs" ]
