module.exports = {
  apps : [{
    name: 'bou-responder',
    script: 'npm',
    args: 'start',
    watch: false,
    restart_delay: 1000,
    log_date_format: 'YYYY-MM-DD HH:mm Z',
    merge_logs: true
  }]
};
