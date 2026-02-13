FROM node:20-alpine
RUN apk add --no-cache docker-cli procps
WORKDIR /app
COPY server.js .
COPY public/ public/
EXPOSE 3009
CMD ["node", "server.js"]
