require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

(async () => {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: 'correo@correo.com',
    password: 'password',
  });
  console.log('ERROR:', error);
  console.log('DATA:', data);
})();
