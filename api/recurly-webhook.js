import { createClient } from '@supabase/supabase-js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseKey) {
      return res.status(500).send('Missing Supabase env vars');
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    const payload = req.body;

    const eventType = payload?.type || payload?.event_type || null;
    const eventId = payload?.id || payload?.event_id || null;

    // Log webhook event
    const { error } = await supabase
      .from('webhook_events')
      .insert({
        provider: 'recurly',
        event_type: eventType,
        event_id: eventId,
        payload: payload,
      });

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).send('Database insert failed');
    }

    return res.status(200).send('Webhook received');
  } catch (err) {
    console.error('Webhook error:', err);
    return res.status(500).send('Server error');
  }
}
