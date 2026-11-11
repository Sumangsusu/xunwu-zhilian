module.exports = {
    content: ["./public/**/*.html", "./public/js/**/*.js"],
    theme: {
        extend: {
            colors: {
                primary: '#3B82F6',
                secondary: '#10B981',
                accent: '#F59E0B',
                dark: '#1E293B',
                light: '#F8FAFC'
            },
            fontFamily: {
                sans: ['Inter', 'Noto Sans SC', 'system-ui', 'sans-serif'],
                display: ['Inter', 'Noto Sans SC', 'sans-serif']
            }
        }
    }
};
