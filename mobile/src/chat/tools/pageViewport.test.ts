import { describe, expect, it } from 'vitest';
import { withDeviceViewport } from './pageViewport';

describe('withDeviceViewport', () => {
  const meta = '<meta name="viewport" content="width=device-width, initial-scale=1">';

  it('põe a largura da tela logo depois do <head>', () => {
    expect(withDeviceViewport('<html><head><title>x</title></head><body></body></html>'))
      .toBe(`<html><head>${meta}<title>x</title></head><body></body></html>`);
  });
  it('sem <head>, põe no começo', () => {
    expect(withDeviceViewport('<div>oi</div>')).toBe(`${meta}<div>oi</div>`);
  });
  it('não confunde <header> com <head>', () => {
    expect(withDeviceViewport('<body><header>t</header></body>')).toBe(`${meta}<body><header>t</header></body>`);
  });
  it('sem <head>, entra depois do <html> e nunca antes do doctype', () => {
    expect(withDeviceViewport('<!DOCTYPE html><html lang="pt"><body></body></html>'))
      .toBe(`<!DOCTYPE html><html lang="pt"><head>${meta}</head><body></body></html>`);
    expect(withDeviceViewport('<!doctype html><div>oi</div>')).toBe(`<!doctype html>${meta}<div>oi</div>`);
  });
  it('não mexe em página que já define o viewport', () => {
    const doc = '<head><meta name="viewport" content="width=400"></head>';
    expect(withDeviceViewport(doc)).toBe(doc);
  });
});
