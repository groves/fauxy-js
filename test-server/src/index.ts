import fastify from "fastify";
import { createReadStream } from "fs";

const server = fastify();

let count = 0;
server.get("/ping", async (request, reply) => {
  return `pong ${count++}\n`;
});
server.get("/minimal.pdf", async (request, reply) => {
  const stream = createReadStream("minimal.pdf");
  return reply.type("application/pdf").send(stream);
});

server.listen({ port: 8080 }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Server listening at ${address}`);
});
