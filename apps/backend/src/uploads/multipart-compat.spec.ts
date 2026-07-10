import { Buffer } from 'node:buffer';
import {
  Controller,
  type INestApplication,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Guard against a regression of GHSA-72gw-mp4g-v24j (Multer <2.2.0 DoS via deeply
// nested field names). We don't ship an upload endpoint yet, so this is a
// forward-looking compatibility test: it wires the NestJS multipart stack
// (@nestjs/platform-express -> multer) exactly as a real feature would and proves
// (a) a normal multipart upload still parses after the multer>=2.2.0 bump, and
// (b) a pathologically nested field name is handled instead of hanging the parser.
@Controller()
class UploadTestController {
  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  upload(@UploadedFile() file: { originalname: string; size: number } | undefined): {
    name: string | null;
    size: number;
  } {
    return { name: file?.originalname ?? null, size: file?.size ?? 0 };
  }
}

describe('multipart upload compatibility (multer >=2.2.0)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [UploadTestController],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('parses a normal multipart file upload', async () => {
    const payload = Buffer.from('hello world');
    const res = await request(app.getHttpServer())
      .post('/upload')
      .attach('file', payload, 'greeting.txt')
      .expect(201);

    expect(res.body.name).toBe('greeting.txt');
    expect(res.body.size).toBe(payload.length);
  });

  it('does not hang on a deeply nested field name (the patched advisory)', async () => {
    // Pre-2.2.0 this class of input drove pathological work in field-name parsing.
    // We only assert the request completes quickly with a normal HTTP status.
    const nested = `a${'[a]'.repeat(500)}`;
    await request(app.getHttpServer())
      .post('/upload')
      .field(nested, 'x')
      .attach('file', Buffer.from('data'), 'f.bin')
      .expect(201);
  });
});
