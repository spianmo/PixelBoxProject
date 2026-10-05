/* 迁移前JS编码器的固定参考，保持原6字节头/低半字节先行契约。 */
const referenceCodec = {
    encodeImaAdpcm(pcm) {
      const data = u8(pcm); if (!data.length || data.length % 2 || data.length > 8192) throw new RangeError('PCM must contain 1..4096 PCM16LE samples');
      const steps = [7,8,9,10,11,12,13,14,16,17,19,21,23,25,28,31,34,37,41,45,50,55,60,66,73,80,88,97,107,118,130,143,157,173,190,209,230,253,279,307,337,371,408,449,494,544,598,658,724,796,876,963,1060,1166,1282,1411,1552,1707,1878,2066,2272,2499,2749,3024,3327,3660,4026,4428,4871,5358,5894,6484,7132,7845,8630,9493,10442,11487,12635,13899,15289,16818,18500,20350,22385,24623,27086,29794,32767];
      const shifts = [-1,-1,-1,-1,2,4,6,8], count = data.length / 2;
      const sample = i => (data[i * 2] | data[i * 2 + 1] << 8) << 16 >> 16;
      let predicted = sample(0), index = 0;
      if (count > 1) while (index < 88 && steps[index] < Math.abs(sample(1) - predicted)) ++index;
      const encoded = new Uint8Array(6 + Math.floor(count / 2));
      encoded[0] = count; encoded[1] = count >> 8; encoded[2] = data[0]; encoded[3] = data[1]; encoded[4] = index;
      for (let i = 1; i < count; ++i) {
        let delta = sample(i) - predicted, code = delta < 0 ? 8 : 0, step = steps[index], change = step >> 3;
        delta = Math.abs(delta);
        for (let bit = 4; bit; bit >>= 1, step >>= 1) if (delta >= step) { code |= bit; delta -= step; change += step; }
        predicted = Math.max(-32768, Math.min(32767, predicted + (code & 8 ? -change : change)));
        index = Math.max(0, Math.min(88, index + shifts[code & 7]));
        encoded[6 + Math.floor((i - 1) / 2)] |= code << (((i - 1) % 2) * 4);
      }
      return encoded.buffer;
    }
};
