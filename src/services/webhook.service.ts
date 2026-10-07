import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { env } from '../config/env.js';

export interface WebhookEventPayload {
  event: string;
  timestamp: string;
  deliveryId: string;
  data: any;
}

export class WebhookService {
  /**
   * Dispatches an event notification to all subscribed NGO endpoints
   */
  public async dispatchEvent(event: string, data: any): Promise<void> {
    try {
      const subscriptions = await prisma.webhookSubscription.findMany({
        where: {
          active: true,
          events: { has: event },
        },
      });

      if (subscriptions.length === 0) return;

      const payload: WebhookEventPayload = {
        event,
        timestamp: new Date().toISOString(),
        deliveryId: crypto.randomUUID(),
        data,
      };

      const payloadString = JSON.stringify(payload);

      await Promise.allSettled(
        subscriptions.map((sub) => this.sendWebhook(sub, payloadString, payload.deliveryId))
      );
    } catch (err) {
      console.error('Error dispatching webhooks:', err);
    }
  }

  /**
   * Sends HTTP POST with HMAC-SHA256 signature to a specific target URL
   */
  public async sendWebhook(
    subscription: { id: string; targetUrl: string; secret: string; failureCount: number },
    payloadString: string,
    deliveryId: string
  ): Promise<boolean> {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = crypto
      .createHmac('sha256', subscription.secret)
      .update(`${timestamp}.${payloadString}`)
      .digest('hex');

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), env.WEBHOOK_TIMEOUT_MS);

      const response = await fetch(subscription.targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'AidTrail-Webhook-Dispatcher/1.0',
          'X-AidTrail-Signature': `t=${timestamp},v1=${signature}`,
          'X-AidTrail-Delivery-Id': deliveryId,
        },
        body: payloadString,
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (response.ok) {
        if (subscription.failureCount > 0) {
          await prisma.webhookSubscription.update({
            where: { id: subscription.id },
            data: { failureCount: 0 },
          });
        }
        return true;
      } else {
        await this.handleFailure(subscription);
        return false;
      }
    } catch {
      await this.handleFailure(subscription);
      return false;
    }
  }

  private async handleFailure(subscription: { id: string; failureCount: number }): Promise<void> {
    const newFailureCount = subscription.failureCount + 1;
    const shouldDeactivate = newFailureCount >= env.WEBHOOK_MAX_RETRIES;

    await prisma.webhookSubscription.update({
      where: { id: subscription.id },
      data: {
        failureCount: newFailureCount,
        active: !shouldDeactivate,
      },
    });
  }
}

export const webhookService = new WebhookService();
