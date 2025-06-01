FROM alpine
WORKDIR /app/

RUN apk add --no-cache nodejs npm

COPY package.json  .

RUN npm i

COPY main.mjs  .

ENTRYPOINT [ "node", "/app/main.mjs" ]
